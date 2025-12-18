import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNextjsCachePlugin,
  extractIdFromArgs,
  extractIncludedRelations,
  generateCacheKey,
  generateCacheTags,
  getCacheRevalidateSeconds,
  getRelatedModels,
  isReadOperation,
  transformDates,
} from './index'

// next/cache モック
vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn, _keys, _options) => fn),
}))

// @zenstackhq/orm モック
vi.mock('@zenstackhq/orm', () => ({
  definePlugin: vi.fn((plugin) => plugin),
}))

// zenstack/schema モック - リレーション定義を含む
vi.mock('zenstack/schema', () => ({
  SchemaType: {},
  schema: {
    models: {
      Category: {
        attributes: [],
        fields: {
          id: { name: 'id', type: 'String' },
          name: { name: 'name', type: 'String' },
          posts: {
            name: 'posts',
            relation: { fields: [], opposite: 'category', references: [] },
            type: 'Post',
          },
        },
        name: 'Category',
      },
      Comment: {
        attributes: [],
        fields: {
          author: {
            name: 'author',
            relation: {
              fields: ['authorId'],
              opposite: 'comments',
              references: ['id'],
            },
            type: 'User',
          },
          authorId: { name: 'authorId', type: 'String' },
          content: { name: 'content', type: 'String' },
          id: { name: 'id', type: 'String' },
          post: {
            name: 'post',
            relation: {
              fields: ['postId'],
              opposite: 'comments',
              references: ['id'],
            },
            type: 'Post',
          },
          postId: { name: 'postId', type: 'String' },
        },
        name: 'Comment',
      },
      Post: {
        attributes: [],
        fields: {
          author: {
            name: 'author',
            relation: {
              fields: ['authorId'],
              opposite: 'posts',
              references: ['id'],
            },
            type: 'User',
          },
          authorId: { name: 'authorId', type: 'String' },
          category: {
            name: 'category',
            relation: {
              fields: ['categoryId'],
              opposite: 'posts',
              references: ['id'],
            },
            type: 'Category',
          },
          categoryId: { name: 'categoryId', type: 'String' },
          comments: {
            name: 'comments',
            relation: { fields: [], opposite: 'post', references: [] },
            type: 'Comment',
          },
          id: { name: 'id', type: 'String' },
          title: { name: 'title', type: 'String' },
        },
        name: 'Post',
      },
      Session: {
        attributes: [{ args: [], name: '@@cache.exclude' }],
        fields: {
          id: { name: 'id', type: 'String' },
        },
        name: 'Session',
      },
      User: {
        attributes: [],
        fields: {
          comments: {
            name: 'comments',
            relation: { fields: [], opposite: 'author', references: [] },
            type: 'Comment',
          },
          email: { name: 'email', type: 'String' },
          id: { name: 'id', type: 'String' },
          name: { name: 'name', type: 'String' },
          posts: {
            name: 'posts',
            relation: { fields: [], opposite: 'author', references: [] },
            type: 'Post',
          },
        },
        name: 'User',
      },
    },
  },
}))

describe('nextjs-cache plugin', () => {
  describe('generateCacheTags', () => {
    it('モデル名からリストタグを生成する', () => {
      const tags = generateCacheTags('User')
      expect(tags).toEqual(['user:list'])
    })

    it('モデル名とIDから複数のタグを生成する', () => {
      const tags = generateCacheTags('User', '123')
      expect(tags).toEqual(['user:list', 'user:123'])
    })

    it('カスタムタグジェネレータを使用できる', () => {
      const customGenerator = (model: string, id?: string) =>
        [`custom:${model}`, id ? `custom:${model}:${id}` : ''].filter(Boolean)

      const tags = generateCacheTags('User', '123', customGenerator)
      expect(tags).toEqual(['custom:User', 'custom:User:123'])
    })

    it('モデル名を小文字に変換する', () => {
      const tags = generateCacheTags('UserProfile')
      expect(tags).toEqual(['userprofile:list'])
    })
  })

  describe('extractIdFromArgs', () => {
    it('where句から文字列IDを抽出する', () => {
      const args = { where: { id: 'abc-123' } }
      expect(extractIdFromArgs(args)).toBe('abc-123')
    })

    it('where句から数値IDを文字列として抽出する', () => {
      const args = { where: { id: 42 } }
      expect(extractIdFromArgs(args)).toBe('42')
    })

    it('where句がない場合はundefinedを返す', () => {
      const args = { select: { name: true } }
      expect(extractIdFromArgs(args)).toBeUndefined()
    })

    it('IDがない場合はundefinedを返す', () => {
      const args = { where: { email: 'test@example.com' } }
      expect(extractIdFromArgs(args)).toBeUndefined()
    })

    it('nullの場合はundefinedを返す', () => {
      expect(extractIdFromArgs(null)).toBeUndefined()
    })

    it('undefinedの場合はundefinedを返す', () => {
      expect(extractIdFromArgs(undefined)).toBeUndefined()
    })

    it('オブジェクトでない場合はundefinedを返す', () => {
      expect(extractIdFromArgs('string')).toBeUndefined()
      // biome-ignore lint/style/noMagicNumbers: テストケースの値
      expect(extractIdFromArgs(123)).toBeUndefined()
    })
  })

  describe('transformDates', () => {
    it('DateオブジェクトをISO文字列に変換する', () => {
      const date = new Date('2024-01-15T10:30:00.000Z')
      expect(transformDates(date)).toBe('2024-01-15T10:30:00.000Z')
    })

    it('ネストしたオブジェクト内のDateを変換する', () => {
      const obj = {
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        name: 'Test',
        nested: {
          updatedAt: new Date('2024-01-16T10:30:00.000Z'),
        },
      }
      const result = transformDates(obj)
      expect(result).toEqual({
        createdAt: '2024-01-15T10:30:00.000Z',
        name: 'Test',
        nested: {
          updatedAt: '2024-01-16T10:30:00.000Z',
        },
      })
    })

    it('配列内のDateを変換する', () => {
      const arr = [
        new Date('2024-01-15T10:30:00.000Z'),
        { date: new Date('2024-01-16T10:30:00.000Z') },
      ]
      const result = transformDates(arr)
      expect(result).toEqual([
        '2024-01-15T10:30:00.000Z',
        { date: '2024-01-16T10:30:00.000Z' },
      ])
    })

    it('nullとundefinedはそのまま返す', () => {
      expect(transformDates(null)).toBeNull()
      expect(transformDates(undefined)).toBeUndefined()
    })

    it('プリミティブ値はそのまま返す', () => {
      expect(transformDates('string')).toBe('string')
      // biome-ignore lint/style/noMagicNumbers: テストケースの値
      expect(transformDates(123)).toBe(123)
      expect(transformDates(true)).toBe(true)
    })
  })

  describe('getCacheRevalidateSeconds', () => {
    it('seconds は 1 秒を返す', () => {
      expect(getCacheRevalidateSeconds('seconds')).toBe(1)
    })

    it('minutes は 60 秒を返す', () => {
      // biome-ignore lint/style/noMagicNumbers: テストケースの期待値
      expect(getCacheRevalidateSeconds('minutes')).toBe(60)
    })

    it('hours は 3600 秒を返す', () => {
      // biome-ignore lint/style/noMagicNumbers: テストケースの期待値
      expect(getCacheRevalidateSeconds('hours')).toBe(3600)
    })

    it('days は 86400 秒を返す', () => {
      // biome-ignore lint/style/noMagicNumbers: テストケースの期待値
      expect(getCacheRevalidateSeconds('days')).toBe(86400)
    })

    it('weeks は 604800 秒を返す', () => {
      // biome-ignore lint/style/noMagicNumbers: テストケースの期待値
      expect(getCacheRevalidateSeconds('weeks')).toBe(604800)
    })

      // biome-ignore lint/style/noMagicNumbers: テストケースの期待値
    it('max は 31536000 秒（1年）を返す', () => {
      expect(getCacheRevalidateSeconds('max')).toBe(31536000)
    })
  })

  describe('generateCacheKey', () => {
    it('モデルと操作からベースキーを生成する', () => {
      const keys = generateCacheKey('User', 'findMany', undefined)
      expect(keys).toEqual(['user:findMany'])
    })

    it('クエリ引数を含むキーを生成する', () => {
      const keys = generateCacheKey('User', 'findMany', { where: { id: '1' } })
      expect(keys).toHaveLength(2)
      expect(keys[0]).toBe('user:findMany')
      expect(keys[1]).toContain('where')
      expect(keys[1]).toContain('id')
    })

    it('空のオブジェクトでも引数キーを生成する', () => {
      const keys = generateCacheKey('Post', 'findFirst', {})
      expect(keys).toHaveLength(2)
      expect(keys[0]).toBe('post:findFirst')
    })

    it('ユーザーIDを指定した場合、キーのプレフィックスにユーザーIDを含める', () => {
      const keys = generateCacheKey('User', 'findMany', undefined, 'user-123')
      expect(keys).toEqual(['user:user-123:user:findMany'])
    })

    it('ユーザーIDとクエリ引数を両方含むキーを生成する', () => {
      const keys = generateCacheKey(
        'Post',
        'findMany',
        { where: { published: true } },
        'user-456',
      )
      expect(keys).toHaveLength(2)
      expect(keys[0]).toBe('user:user-456:post:findMany')
      expect(keys[1]).toContain('published')
    })

    it('ユーザーIDがundefinedの場合、プレフィックスは追加されない', () => {
      const keys = generateCacheKey('User', 'findMany', undefined, undefined)
      expect(keys).toEqual(['user:findMany'])
    })
  })

  describe('isReadOperation', () => {
    it.each([
      'findMany',
      'findUnique',
      'findFirst',
      'findUniqueOrThrow',
      'findFirstOrThrow',
      'count',
      'aggregate',
      'groupBy',
    ])('%s は読み取り操作として判定される', (operation) => {
      expect(isReadOperation(operation)).toBe(true)
    })

    it.each([
      'create',
      'createMany',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
      'upsert',
    ])('%s は読み取り操作ではないと判定される', (operation) => {
      expect(isReadOperation(operation)).toBe(false)
    })
  })

  describe('createNextjsCachePlugin', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('デフォルトオプションでプラグインを作成できる', () => {
      const plugin = createNextjsCachePlugin()
      expect(plugin).toHaveProperty('id', 'nextjs-cache')
      expect(plugin).toHaveProperty('onQuery')
      expect(plugin).toHaveProperty('onEntityMutation')
    })

    it('カスタムオプションでプラグインを作成できる', () => {
      const plugin = createNextjsCachePlugin({
        defaultCacheLife: 'days',
        excludeModels: ['CustomModel'],
      })
      expect(plugin).toHaveProperty('id', 'nextjs-cache')
    })

    describe('onQuery', () => {
      it('除外モデルはスキップしてproceedを呼ぶ', async () => {
        const plugin = createNextjsCachePlugin({
          excludeModels: ['Session'],
        })

        const proceed = vi.fn().mockResolvedValue({ id: '1' })
        const ctx = {
          args: {},
          client: { $auth: undefined },
          model: 'Session',
          operation: 'findMany',
          proceed,
        }

        // @ts-expect-error テスト用の簡略化されたctx
        const result = await plugin.onQuery(ctx)

        expect(proceed).toHaveBeenCalledWith({})
        expect(result).toEqual({ id: '1' })
      })

      it('読み取り操作でDate型をISO文字列に変換する', async () => {
        const plugin = createNextjsCachePlugin()

        const date = new Date('2024-01-15T10:30:00.000Z')
        const proceed = vi.fn().mockResolvedValue({
          createdAt: date,
          id: '1',
        })
        const ctx = {
          args: { where: { id: '1' } },
          client: { $auth: undefined },
          model: 'User',
          operation: 'findUnique',
          proceed,
        }

        // @ts-expect-error テスト用の簡略化されたctx
        const result = await plugin.onQuery(ctx)

        expect(result).toEqual({
          createdAt: '2024-01-15T10:30:00.000Z',
          id: '1',
        })
      })

      it('書き込み操作ではDate変換をスキップする', async () => {
        const plugin = createNextjsCachePlugin()

        const date = new Date('2024-01-15T10:30:00.000Z')
        const proceed = vi.fn().mockResolvedValue({
          createdAt: date,
          id: '1',
        })
        const ctx = {
          args: { data: { name: 'Test' } },
          client: { $auth: undefined },
          model: 'User',
          operation: 'create',
          proceed,
        }

        // @ts-expect-error テスト用の簡略化されたctx
        const result = await plugin.onQuery(ctx)

        expect(result).toEqual({
          createdAt: date, // Dateオブジェクトのまま
          id: '1',
        })
      })
    })

    describe('onEntityMutation', () => {
      it('afterEntityMutationが定義されている', () => {
        const plugin = createNextjsCachePlugin()
        expect(plugin.onEntityMutation).toHaveProperty('afterEntityMutation')
      })

      it('ミューテーション後にキャッシュを無効化する', async () => {
        const { revalidateTag } = await import('next/cache')
        const plugin = createNextjsCachePlugin()

        const loadAfterMutationEntities = vi
          .fn()
          .mockResolvedValue([{ id: '1', name: 'Test' }])

        const args = {
          loadAfterMutationEntities,
          model: 'User',
        }

        // @ts-expect-error テスト用の簡略化されたargs
        await plugin.onEntityMutation.afterEntityMutation(args)

        expect(revalidateTag).toHaveBeenCalledWith('user:list', 'max')
        expect(revalidateTag).toHaveBeenCalledWith('user:1', 'max')
      })
    })
  })

  describe('extractIncludedRelations', () => {
    it('include句からリレーションを抽出する', () => {
      const args = { include: { author: true } }
      const relations = extractIncludedRelations(args, 'Post')
      expect(relations).toEqual(['User'])
    })

    it('複数のリレーションを抽出する', () => {
      const args = { include: { author: true, category: true, comments: true } }
      const relations = extractIncludedRelations(args, 'Post')
      expect(relations).toContain('User')
      expect(relations).toContain('Comment')
      expect(relations).toContain('Category')
    })

    it('false のリレーションは抽出しない', () => {
      const args = { include: { author: true, comments: false } }
      const relations = extractIncludedRelations(args, 'Post')
      expect(relations).toEqual(['User'])
    })

    it('select句からネストされたリレーションを抽出する', () => {
      const args = { select: { author: { select: { name: true } }, id: true } }
      const relations = extractIncludedRelations(args, 'Post')
      expect(relations).toEqual(['User'])
    })

    it('include句がない場合は空配列を返す', () => {
      const args = { where: { id: '1' } }
      const relations = extractIncludedRelations(args, 'Post')
      expect(relations).toEqual([])
    })

    it('null/undefined の場合は空配列を返す', () => {
      expect(extractIncludedRelations(null, 'Post')).toEqual([])
      expect(extractIncludedRelations(undefined, 'Post')).toEqual([])
    })

    it('存在しないフィールドは無視する', () => {
      const args = { include: { author: true, nonExistent: true } }
      const relations = extractIncludedRelations(args, 'Post')
      expect(relations).toEqual(['User'])
    })
  })

  describe('getRelatedModels', () => {
    it('モデルのリレーション先を取得する', () => {
      const related = getRelatedModels('Post')
      expect(related).toContain('User')
      expect(related).toContain('Comment')
      expect(related).toContain('Category')
    })

    it('User のリレーション先を取得する', () => {
      const related = getRelatedModels('User')
      expect(related).toContain('Post')
      expect(related).toContain('Comment')
    })

    it('存在しないモデルは空配列を返す', () => {
      const related = getRelatedModels('NonExistent')
      expect(related).toEqual([])
    })
  })

  describe('リレーションを含むクエリのキャッシュタグ', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('findMany with include でリレーションタグが追加される', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi
        .fn()
        .mockResolvedValue([
          { author: { id: 'u1', name: 'User' }, id: '1', title: 'Post 1' },
        ])
      const ctx = {
        args: { include: { author: true } },
        client: { $auth: undefined },
        model: 'Post',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      // unstable_cache がタグ付きで呼ばれることを確認
      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Array),
        expect.objectContaining({
          tags: expect.arrayContaining(['post:list', 'user:list']),
        }),
      )
    })

    it('findMany with 複数include で複数のリレーションタグが追加される', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue([])
      const ctx = {
        args: { include: { author: true, category: true, comments: true } },
        client: { $auth: undefined },
        model: 'Post',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Array),
        expect.objectContaining({
          tags: expect.arrayContaining([
            'post:list',
            'user:list',
            'comment:list',
            'category:list',
          ]),
        }),
      )
    })

    it('findUnique with include でリレーションタグが追加される', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue({
        author: { id: 'u1', name: 'User' },
        id: 'post-123',
        title: 'Post',
      })
      const ctx = {
        args: { include: { author: true }, where: { id: 'post-123' } },
        client: { $auth: undefined },
        model: 'Post',
        operation: 'findUnique',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      // post:list, post:post-123, user:list が設定される
      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Array),
        expect.objectContaining({
          tags: expect.arrayContaining([
            'post:list',
            'post:post-123',
            'user:list',
          ]),
        }),
      )
    })

    it('include なしの場合はリレーションタグは追加されない', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue([{ id: '1', title: 'Post' }])
      const ctx = {
        args: {},
        client: { $auth: undefined },
        model: 'Post',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Array),
        expect.objectContaining({
          tags: ['post:list'],
        }),
      )
    })

    it('select によるネストされたリレーションでもタグが追加される', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi
        .fn()
        .mockResolvedValue([{ author: { name: 'User' }, id: '1' }])
      const ctx = {
        args: { select: { author: { select: { name: true } }, id: true } },
        client: { $auth: undefined },
        model: 'Post',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Array),
        expect.objectContaining({
          tags: expect.arrayContaining(['post:list', 'user:list']),
        }),
      )
    })
  })

  describe('ポリシープラグイン使用時のキャッシュキー', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('$authが設定されている場合、キャッシュキーにユーザーIDが含まれる', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue([{ id: '1', name: 'Test' }])
      const ctx = {
        args: {},
        client: { $auth: { id: 'user-abc-123' } },
        model: 'User',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      // キャッシュキーにユーザーIDが含まれることを確認
      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.arrayContaining(['user:user-abc-123:user:findMany']),
        expect.any(Object),
      )
    })

    it('$authがundefinedの場合、キャッシュキーにユーザーIDは含まれない', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue([{ id: '1', name: 'Test' }])
      const ctx = {
        args: {},
        client: { $auth: undefined },
        model: 'User',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      // キャッシュキーにユーザープレフィックスが含まれないことを確認
      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.arrayContaining(['user:findMany']),
        expect.any(Object),
      )
    })

    it('$authにidが含まれない場合、キャッシュキーにユーザーIDは含まれない', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue([{ id: '1', name: 'Test' }])
      const ctx = {
        args: {},
        client: { $auth: { name: 'No ID User' } },
        model: 'User',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx)

      // キャッシュキーにユーザープレフィックスが含まれないことを確認
      expect(unstable_cache).toHaveBeenCalledWith(
        expect.any(Function),
        expect.arrayContaining(['user:findMany']),
        expect.any(Object),
      )
    })

    it('異なるユーザーIDでは異なるキャッシュキーが生成される', async () => {
      const { unstable_cache } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const proceed = vi.fn().mockResolvedValue([])

      // ユーザー1のクエリ
      const ctx1 = {
        args: { where: { active: true } },
        client: { $auth: { id: 'user-1' } },
        model: 'Post',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx1)

      // ユーザー2のクエリ
      const ctx2 = {
        args: { where: { active: true } },
        client: { $auth: { id: 'user-2' } },
        model: 'Post',
        operation: 'findMany',
        proceed,
      }

      // @ts-expect-error テスト用の簡略化されたctx
      await plugin.onQuery(ctx2)

      // 2回呼ばれ、それぞれ異なるユーザーIDを含むキャッシュキーであること
      expect(unstable_cache).toHaveBeenCalledTimes(2)
      const calls = (unstable_cache as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(calls[0][1]).toContainEqual('user:user-1:post:findMany')
      expect(calls[1][1]).toContainEqual('user:user-2:post:findMany')
    })
  })

  describe('リレーションを考慮したキャッシュ無効化', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('User更新時にPostとCommentのリストキャッシュも無効化される', async () => {
      const { revalidateTag } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const loadAfterMutationEntities = vi
        .fn()
        .mockResolvedValue([{ id: 'user-1', name: 'Updated User' }])

      const args = {
        loadAfterMutationEntities,
        model: 'User',
      }

      // @ts-expect-error テスト用の簡略化されたargs
      await plugin.onEntityMutation.afterEntityMutation(args)

      // User 自身のキャッシュ無効化
      expect(revalidateTag).toHaveBeenCalledWith('user:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('user:user-1', 'max')

      // リレーション先のキャッシュも無効化
      expect(revalidateTag).toHaveBeenCalledWith('post:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('comment:list', 'max')
    })

    it('Post更新時にUser/Comment/Categoryのリストキャッシュも無効化される', async () => {
      const { revalidateTag } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const loadAfterMutationEntities = vi
        .fn()
        .mockResolvedValue([{ id: 'post-1', title: 'Updated Post' }])

      const args = {
        loadAfterMutationEntities,
        model: 'Post',
      }

      // @ts-expect-error テスト用の簡略化されたargs
      await plugin.onEntityMutation.afterEntityMutation(args)

      // Post 自身のキャッシュ無効化
      expect(revalidateTag).toHaveBeenCalledWith('post:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('post:post-1', 'max')

      // リレーション先のキャッシュも無効化
      expect(revalidateTag).toHaveBeenCalledWith('user:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('comment:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('category:list', 'max')
    })

    it('Comment更新時にUser/Postのリストキャッシュも無効化される', async () => {
      const { revalidateTag } = await import('next/cache')
      const plugin = createNextjsCachePlugin()

      const loadAfterMutationEntities = vi
        .fn()
        .mockResolvedValue([{ content: 'Updated Comment', id: 'comment-1' }])

      const args = {
        loadAfterMutationEntities,
        model: 'Comment',
      }

      // @ts-expect-error テスト用の簡略化されたargs
      await plugin.onEntityMutation.afterEntityMutation(args)

      // Comment 自身のキャッシュ無効化
      expect(revalidateTag).toHaveBeenCalledWith('comment:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('comment:comment-1', 'max')

      // リレーション先のキャッシュも無効化
      expect(revalidateTag).toHaveBeenCalledWith('user:list', 'max')
      expect(revalidateTag).toHaveBeenCalledWith('post:list', 'max')
    })
  })
})
