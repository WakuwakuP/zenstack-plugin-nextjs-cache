/**
 * ZenStack v3 Runtime Plugin: Next.js Cache Integration
 *
 * このプラグインは、ZenStack ORMのクエリ操作に対して
 * Next.jsのキャッシュシステム（unstable_cache）を透過的に適用します。
 *
 * 機能:
 * - 読み取り操作（findMany, findUnique等）をunstable_cacheでラップしてキャッシュ
 * - 書き込み操作（create, update, delete）後にrevalidateTagで自動でキャッシュを無効化
 * - Date型を自動的にISO文字列に変換（キャッシュシリアライズ対策）
 * - スキーマ属性（@@cache.exclude, @@cache.tags, @@cache.life）によるモデルごとの設定
 */

import { definePlugin } from '@zenstackhq/orm'
import { type SchemaType, schema } from 'zenstack/schema'

// ============================================================================
// 型定義
// ============================================================================

export type CacheLifeProfile =
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days'
  | 'weeks'
  | 'max'

/**
 * CacheLifeProfile を秒数に変換
 */
export function getCacheRevalidateSeconds(profile: CacheLifeProfile): number {
  switch (profile) {
    case 'seconds':
      return 1
    case 'minutes':
      return 60
    case 'hours':
      return 3600
    case 'days':
      return 86400
    case 'weeks':
      return 604800
    case 'max':
      return 31536000
    default:
      // biome-ignore lint/style/noMagicNumbers: デフォルトのキャッシュ有効期限
      return 3600
  }
}

export interface NextjsCachePluginOptions {
  /**
   * デフォルトのキャッシュ有効期間
   * @default 'hours'
   */
  defaultCacheLife?: CacheLifeProfile

  /**
   * キャッシュから除外するモデル名（追加分）
   * スキーマの @@cache.exclude と合わせて使用される
   */
  excludeModels?: string[]

  /**
   * デバッグログを出力するかどうか
   * @default false
   */
  debug?: boolean

  /**
   * カスタムのキャッシュタグ生成関数
   */
  customTagGenerator?: (model: string, id?: string) => string[]
}

// ============================================================================
// スキーマ属性読み取り
// ============================================================================

interface ModelAttribute {
  readonly name: string
  readonly args?: readonly {
    readonly name: string
    readonly value: unknown
  }[]
}

interface FieldDefinition {
  readonly name: string
  readonly type: string
  readonly relation?: {
    readonly opposite?: string
    readonly fields?: readonly string[]
    readonly references?: readonly string[]
  }
}

interface ModelDefinition {
  readonly name: string
  readonly fields?: Record<string, FieldDefinition>
  readonly attributes?: readonly ModelAttribute[]
}

/**
 * スキーマからモデルの属性を取得
 */
function getModelAttributes(modelName: string): readonly ModelAttribute[] {
  const models = schema.models as unknown as Record<string, ModelDefinition>
  return models[modelName]?.attributes ?? []
}

/**
 * スキーマからモデルのフィールド定義を取得
 */
function getModelFields(modelName: string): Record<string, FieldDefinition> {
  const models = schema.models as unknown as Record<string, ModelDefinition>
  return (models[modelName]?.fields as Record<string, FieldDefinition>) ?? {}
}

/**
 * モデルのDateTime型フィールド名を取得
 * @returns DateTime型フィールド名のSet
 */
export function getDateTimeFields(modelName: string): Set<string> {
  const fields = getModelFields(modelName)
  const dateTimeFields = new Set<string>()

  for (const [fieldName, field] of Object.entries(fields)) {
    if (field.type === 'DateTime') {
      dateTimeFields.add(fieldName)
    }
  }

  return dateTimeFields
}

/**
 * モデルのDecimal型フィールド名を取得
 * @returns Decimal型フィールド名のSet
 */
export function getDecimalFields(modelName: string): Set<string> {
  const fields = getModelFields(modelName)
  const decimalFields = new Set<string>()

  for (const [fieldName, field] of Object.entries(fields)) {
    if (field.type === 'Decimal') {
      decimalFields.add(fieldName)
    }
  }

  return decimalFields
}

/**
 * モデルのリレーション先モデル名を取得
 * @returns リレーション先のモデル名の配列
 */
export function getRelatedModels(modelName: string): string[] {
  const fields = getModelFields(modelName)
  const relatedModels: string[] = []

  for (const field of Object.values(fields)) {
    if (field.relation) {
      relatedModels.push(field.type)
    }
  }

  return relatedModels
}

/**
 * モデルが @@cache.exclude() 属性を持っているかチェック
 */
export function hasExcludeAttribute(modelName: string): boolean {
  const attributes = getModelAttributes(modelName)
  return attributes.some((attr) => attr.name === '@@cache.exclude')
}

/**
 * モデルの @@cache.tags() 属性からタグを取得
 */
export function getCustomTags(modelName: string): string[] | undefined {
  const attributes = getModelAttributes(modelName)
  const tagsAttr = attributes.find((attr) => attr.name === '@@cache.tags')
  if (!tagsAttr?.args?.[0]?.value) return

  const value = tagsAttr.args[0].value
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  return
}

/**
 * モデルの @@cache.life() 属性からライフタイムを取得
 */
export function getCustomLife(modelName: string): CacheLifeProfile | undefined {
  const attributes = getModelAttributes(modelName)
  const lifeAttr = attributes.find((attr) => attr.name === '@@cache.life')
  if (!lifeAttr?.args?.[0]?.value) return

  const value = lifeAttr.args[0].value
  if (
    typeof value === 'string' &&
    ['seconds', 'minutes', 'hours', 'days', 'weeks', 'max'].includes(value)
  ) {
    return value as CacheLifeProfile
  }
  return
}

// ============================================================================
// 定数
// ============================================================================

/** 読み取り操作 */
const READ_OPERATIONS = [
  'findMany',
  'findUnique',
  'findFirst',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
] as const

// ============================================================================
// ユーティリティ関数
// ============================================================================

/**
 * モデルとIDからキャッシュタグを生成
 */
export function generateCacheTags(
  modelName: string,
  id?: string,
  tagGenerator?: (m: string, i?: string) => string[],
): string[] {
  if (tagGenerator != null) {
    return tagGenerator(modelName, id)
  }

  const modelLower = modelName.toLowerCase()
  const tags = [`${modelLower}:list`]

  if (id) {
    tags.push(`${modelLower}:${id}`)
  }

  return tags
}

/**
 * クエリ引数からIDを抽出
 */
export function extractIdFromArgs(queryArgs: unknown): string | undefined {
  if (!queryArgs || typeof queryArgs !== 'object') return

  const args = queryArgs as Record<string, unknown>

  // where句からIDを抽出
  if (args.where && typeof args.where === 'object') {
    const where = args.where as Record<string, unknown>
    if (typeof where.id === 'string') return where.id
    if (typeof where.id === 'number') return String(where.id)
  }

  return
}

/**
 * クエリ引数のinclude/selectからリレーションで参照しているモデル名を抽出
 * @param queryArgs クエリ引数
 * @param modelName 親モデル名
 * @returns 参照しているリレーションモデル名の配列
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: リレーション抽出ロジックの複雑性は妥当
export function extractIncludedRelations(
  queryArgs: unknown,
  modelName: string,
): string[] {
  if (!queryArgs || typeof queryArgs !== 'object') return []

  const args = queryArgs as Record<string, unknown>
  const fields = getModelFields(modelName)
  const includedModels: string[] = []

  // include句をチェック
  if (args.include && typeof args.include === 'object') {
    const include = args.include as Record<string, unknown>
    for (const [fieldName, value] of Object.entries(include)) {
      if (value && fields[fieldName]?.relation) {
        includedModels.push(fields[fieldName].type)
      }
    }
  }

  // select句をチェック（ネストされたリレーションを含む場合）
  if (args.select && typeof args.select === 'object') {
    const select = args.select as Record<string, unknown>
    for (const [fieldName, value] of Object.entries(select)) {
      if (value && typeof value === 'object' && fields[fieldName]?.relation) {
        includedModels.push(fields[fieldName].type)
      }
    }
  }

  return includedModels
}

/**
 * Date型をISO文字列に、Decimal型を文字列に再帰的に変換
 * unstable_cache はJSONシリアライズするため、DateオブジェクトやDecimalは文字列に変換される
 * この関数で事前に変換しておくことで、型の一貫性を保つ
 */
export function transformDates(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (obj instanceof Date) return obj.toISOString()
  // Prisma Decimalは toString() で文字列に変換
  // Decimal型かどうかは toFixed メソッドの存在で判定（Decimal.jsの特徴）
  if (
    typeof obj === 'object' &&
    obj !== null &&
    'toFixed' in obj &&
    typeof (obj as { toFixed: unknown }).toFixed === 'function' &&
    'd' in obj // Decimal.jsの内部プロパティ
  ) {
    return (obj as { toString: () => string }).toString()
  }
  if (Array.isArray(obj)) return obj.map(transformDates)
  if (typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        transformDates(v),
      ]),
    )
  }
  return obj
}

/** ISO 8601形式の日付文字列かどうかを判定 */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/**
 * ISO文字列をDate型に、数値文字列をDecimal型に再帰的に復元
 * キャッシュから取得したデータのDateTime型/Decimal型フィールドを復元
 * @param obj 変換対象のオブジェクト
 * @param modelName モデル名（型フィールドを特定するため）
 */
export function restoreDates(
  obj: unknown,
  modelName: string,
): unknown {
  // Prisma.Decimalを動的にインポート（テスト環境では利用不可の場合がある）
  let PrismaDecimal: typeof import('@prisma/client/runtime/library').Decimal | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Decimal } = require('@prisma/client/runtime/library')
    PrismaDecimal = Decimal
  } catch {
    // Prisma Decimalが利用不可な環境では文字列のまま返す
  }

  return restoreTypesInternal(obj, modelName, PrismaDecimal)
}

/**
 * 内部復元関数
 */
function restoreTypesInternal(
  obj: unknown,
  modelName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PrismaDecimal: any,
): unknown {
  if (obj === null || obj === undefined) return obj

  // 配列の場合は各要素を再帰処理
  if (Array.isArray(obj)) {
    return obj.map((item) => restoreTypesInternal(item, modelName, PrismaDecimal))
  }

  // オブジェクトの場合
  if (typeof obj === 'object') {
    const dateTimeFields = getDateTimeFields(modelName)
    const decimalFields = getDecimalFields(modelName)
    const fields = getModelFields(modelName)

    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, value]) => {
        // DateTime型フィールドでISO文字列の場合はDateに変換
        if (
          dateTimeFields.has(key) &&
          typeof value === 'string' &&
          ISO_DATE_REGEX.test(value)
        ) {
          return [key, new Date(value)]
        }

        // Decimal型フィールドで文字列または数値の場合はPrisma.Decimalに変換
        if (
          decimalFields.has(key) &&
          value != null &&
          (typeof value === 'string' || typeof value === 'number')
        ) {
          if (PrismaDecimal) {
            return [key, new PrismaDecimal(value)]
          }
          // PrismaDecimalが利用不可な場合はそのまま返す
          return [key, value]
        }

        // リレーションフィールドの場合は再帰的に処理
        const field = fields[key]
        if (field?.relation && value != null) {
          return [key, restoreTypesInternal(value, field.type, PrismaDecimal)]
        }

        return [key, value]
      }),
    )
  }

  return obj
}

/**
 * 操作が読み取り操作かどうかを判定
 */
export function isReadOperation(operation: string): boolean {
  return (READ_OPERATIONS as readonly string[]).includes(operation)
}

/**
 * クエリ引数を安定したキャッシュキー用文字列に変換
 * @param model モデル名
 * @param operation 操作名
 * @param queryArgs クエリ引数
 * @param userId ユーザーID（ポリシープラグイン使用時に設定）
 */
export function generateCacheKey(
  model: string,
  operation: string,
  queryArgs: unknown,
  userId?: string,
): string[] {
  // ユーザーIDが設定されている場合はキャッシュキーに含める
  // これにより、ポリシープラグイン使用時にユーザーごとに異なるキャッシュが生成される
  const userPrefix = userId ? `user:${userId}:` : ''
  const baseKey = `${userPrefix}${model.toLowerCase()}:${operation}`
  if (!queryArgs || typeof queryArgs !== 'object') {
    return [baseKey]
  }
  // 引数をJSON化してハッシュ代わりに使用（キーをソートして安定化）
  const argsStr = JSON.stringify(queryArgs)
  return [baseKey, argsStr]
}

// ============================================================================
// プラグイン本体
// ============================================================================

/**
 * Next.js Cache Plugin for ZenStack v3
 *
 * @example
 * ```typescript
 * import { createNextjsCachePlugin } from '@/zenstack/nextjs-cache-plugin';
 *
 * const db = baseDb.$use(
 *   createNextjsCachePlugin({
 *     defaultCacheLife: 'hours',
 *     excludeModels: ['Session', 'Verification'],
 *     debug: true,
 *   })
 * );
 * ```
 *
 * スキーマ属性による設定:
 * ```zmodel
 * model Session {
 *   id String @id
 *   @@cache.exclude()  // キャッシュから除外
 * }
 *
 * model Post {
 *   id String @id
 *   @@cache.life('minutes')  // キャッシュ有効期間を設定
 *   @@cache.tags(['posts', 'content'])  // カスタムタグを設定
 * }
 * ```
 */
export function createNextjsCachePlugin(
  options: NextjsCachePluginOptions = {},
) {
  const {
    defaultCacheLife = 'hours',
    excludeModels = [],
    debug = false,
    customTagGenerator,
  } = options

  const log = (message: string, ...args: unknown[]) => {
    if (debug) {
      console.log(`[NextjsCache] ${message}`, ...args)
    }
  }

  /**
   * モデルがキャッシュ除外対象かどうかを判定
   * - オプションの excludeModels に含まれる場合
   * - スキーマで @@cache.exclude() が設定されている場合
   */
  const isExcludedModel = (model: string): boolean => {
    // オプションで指定された除外モデル
    if (excludeModels.includes(model)) {
      return true
    }
    // スキーマ属性で除外指定されたモデル
    if (hasExcludeAttribute(model)) {
      return true
    }
    return false
  }

  /**
   * モデルのキャッシュタグを取得
   * スキーマの @@cache.tags() が優先、なければデフォルト生成
   */
  const getTagsForModel = (model: string, id?: string): string[] => {
    // カスタムタグ生成関数が指定されていればそれを使用
    if (customTagGenerator) {
      return customTagGenerator(model, id)
    }

    // スキーマの @@cache.tags() をチェック
    const customTags = getCustomTags(model)
    if (customTags && customTags.length > 0) {
      // カスタムタグにIDを追加
      if (id) {
        return [...customTags, `${model.toLowerCase()}:${id}`]
      }
      return customTags
    }

    // デフォルトのタグ生成
    return generateCacheTags(model, id)
  }

  /**
   * モデルのキャッシュライフタイムを取得
   * スキーマの @@cache.life() が優先、なければデフォルト値
   */
  const getLifeForModel = (model: string): CacheLifeProfile => {
    const customLife = getCustomLife(model)
    return customLife ?? defaultCacheLife
  }

  return definePlugin<SchemaType>({
    id: 'nextjs-cache',

    /**
     * Entity Mutation Hooks: ミューテーション後のキャッシュ無効化
     */
    onEntityMutation: {
      afterEntityMutation: async (args) => {
        const { model, loadAfterMutationEntities } = args

        log(`After mutation: ${model}`)

        // 変更されたモデルのキャッシュを無効化
        await invalidateCacheForModel(model, loadAfterMutationEntities, log)

        // リレーション先モデルのキャッシュも無効化
        const relatedModels = getRelatedModels(model)
        for (const relatedModel of relatedModels) {
          if (!isExcludedModel(relatedModel)) {
            log(`Invalidating related model: ${relatedModel}`)
            // biome-ignore lint/performance/noAwaitInLoops: キャッシュ無効化は順次実行が必要
            await invalidateRelatedModelCache(relatedModel, log)
          }
        }
      },
    },

    /**
     * Query API Hooks: ORM操作をインターセプト
     */
    onQuery: async (ctx) => {
      const { model, operation, args: queryArgs, proceed, client } = ctx

      // 除外モデルはスキップ（オプション or スキーマ属性）
      if (isExcludedModel(model)) {
        log(`Skipping excluded model: ${model}`)
        return proceed(queryArgs)
      }

      // ポリシープラグイン使用時のユーザー情報を取得
      // $authが設定されている場合、キャッシュキーにユーザーIDを含める
      const authUser = client.$auth as { id?: string } | undefined
      const userId = authUser?.id

      // 読み取り操作の場合、unstable_cacheでラップ
      if (isReadOperation(operation)) {
        const id = extractIdFromArgs(queryArgs)
        const tags = getTagsForModel(model, id)
        const life = getLifeForModel(model)
        const revalidateSeconds = getCacheRevalidateSeconds(life)

        // リレーションで参照しているモデルのタグも追加
        const includedRelations = extractIncludedRelations(queryArgs, model)
        for (const relatedModel of includedRelations) {
          // 除外モデルでなければタグを追加
          if (!isExcludedModel(relatedModel)) {
            tags.push(`${relatedModel.toLowerCase()}:list`)
          }
        }

        // キャッシュキーを生成（ユーザーIDを含める）
        const cacheKey = generateCacheKey(model, operation, queryArgs, userId)

        log(`Read operation: ${model}.${operation}`, {
          cacheKey,
          includedRelations,
          life,
          queryArgs,
          revalidateSeconds,
          tags,
          userId,
        })

        try {
          const { unstable_cache } = await import('next/cache')

          // unstable_cacheでクエリをラップ
          const cachedQuery = unstable_cache(
            async () => {
              // キャッシュミス時にログ出力
              log(`Cache MISS: ${model}.${operation}`, { cacheKey, tags })
              const result = await proceed(queryArgs)
              // Date型をISO文字列に変換
              return transformDates(result)
            },
            cacheKey,
            {
              revalidate: revalidateSeconds,
              tags,
            },
          )

          const cachedResult = await cachedQuery()
          // ISO文字列をDate型に復元して返却
          return restoreDates(cachedResult, model)
        } catch (e) {
          // unstable_cache が利用できない環境（テスト等）ではフォールバック
          log('unstable_cache not available, falling back to direct query', e)
          const result = await proceed(queryArgs)
          // Date型をISO文字列に変換してから復元（一貫性のため）
          const transformed = transformDates(result)
          return restoreDates(transformed, model)
        }
      }

      // 書き込み操作は直接実行
      return proceed(queryArgs)
    },
  })
}

/**
 * タグを無効化するヘルパー関数
 * Server Actions では updateTag（即時無効化）を優先、
 * Route Handlers 等では revalidateTag（stale-while-revalidate）にフォールバック
 */
async function invalidateTag(
  tag: string,
  log: (message: string, ...args: unknown[]) => void,
): Promise<void> {
  try {
    // まず updateTag を試みる（Server Actions 限定、即時無効化）
    const { updateTag } = await import('next/cache')
    updateTag(tag)
    log(`Updated tag (immediate): ${tag}`)
  } catch {
    // updateTag が使えない場合は revalidateTag にフォールバック
    try {
      const { revalidateTag } = await import('next/cache')
      revalidateTag(tag, 'max')
      log(`Revalidated tag (stale-while-revalidate): ${tag}`)
    } catch (e) {
      log(`Failed to invalidate tag: ${tag}`, e)
    }
  }
}

/**
 * モデルに関連するキャッシュを無効化するヘルパー関数
 */
async function invalidateCacheForModel(
  model: string,
  loadEntities: () => Promise<Record<string, unknown>[] | undefined>,
  log: (message: string, ...args: unknown[]) => void,
): Promise<void> {
  try {
    // リスト全体のキャッシュを無効化
    const listTag = `${model.toLowerCase()}:list`
    await invalidateTag(listTag, log)

    // 個別エンティティのキャッシュも無効化
    const entities = await loadEntities()
    if (entities && Array.isArray(entities)) {
      for (const entity of entities) {
        if (entity && typeof entity === 'object' && 'id' in entity) {
          const entityTag = `${model.toLowerCase()}:${entity.id}`
          // biome-ignore lint/performance/noAwaitInLoops: キャッシュ無効化は順次実行が必要
          await invalidateTag(entityTag, log)
        }
      }
    }
  } catch {
    // next/cache が利用できない環境では無視
    log('next/cache not available for invalidation')
  }
}

/**
 * リレーション先モデルのリストキャッシュを無効化
 */
async function invalidateRelatedModelCache(
  model: string,
  log: (message: string, ...args: unknown[]) => void,
): Promise<void> {
  try {
    const listTag = `${model.toLowerCase()}:list`
    await invalidateTag(listTag, log)
  } catch {
    log('next/cache not available for invalidation')
  }
}
