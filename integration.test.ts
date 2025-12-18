/**
 * Next.js Cache Plugin 統合テスト
 *
 * SQLite（インメモリ）を使用して、プラグインの動作をテストします。
 * 外部データベースへの依存なしにテストを実行できます。
 */

import { type ClientContract, ZenStackClient } from '@zenstackhq/orm'
import { SqliteDialect } from '@zenstackhq/orm/dialects/sqlite'
import Database from 'better-sqlite3'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { createNextjsCachePlugin } from './index'

// next/cache のモック
const mockCacheTag = vi.fn()
const mockCacheLife = vi.fn()
const mockUpdateTag = vi.fn()
const mockUnstableCache = vi.fn(
  (fn: () => Promise<unknown>, _keys: string[], _options?: object) => {
    // unstable_cache は関数を返す
    return fn
  },
)

vi.mock('next/cache', () => ({
  cacheLife: (...args: unknown[]) => mockCacheLife(...args),
  cacheTag: (...args: unknown[]) => mockCacheTag(...args),
  unstable_cache: (
    fn: () => Promise<unknown>,
    keys: string[],
    options?: object,
  ) => mockUnstableCache(fn, keys, options),
  updateTag: (...args: unknown[]) => mockUpdateTag(...args),
}))

// テスト用のユニークIDを生成
// biome-ignore lint/style/noMagicNumbers: テスト用ID生成
const testId = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`

// テスト用のスキーマ定義（SQLite用に簡略化）
import { ExpressionUtils } from '@zenstackhq/orm/schema'

const testSchema = {
  models: {
    Session: {
      fields: {
        id: { id: true, name: 'id', type: 'String' },
        token: { name: 'token', type: 'String' },
        userId: { name: 'userId', type: 'String' },
      },
      idFields: ['id'],
      name: 'Session',
      uniqueFields: { id: { type: 'String' } },
    },
    User: {
      fields: {
        createdAt: {
          default: ExpressionUtils.call('now'),
          name: 'createdAt',
          optional: true,
          type: 'DateTime',
        },
        email: { name: 'email', type: 'String' },
        id: { id: true, name: 'id', type: 'String' },
        name: { name: 'name', type: 'String' },
        updatedAt: {
          default: ExpressionUtils.call('now'),
          name: 'updatedAt',
          optional: true,
          type: 'DateTime',
          updatedAt: true,
        },
      },
      idFields: ['id'],
      name: 'User',
      uniqueFields: { email: { type: 'String' }, id: { type: 'String' } },
    },
  },
  provider: { type: 'sqlite' as const },
}

describe('Next.js Cache Plugin 統合テスト', () => {
  let sqlite: Database.Database
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // biome-ignore lint/suspicious/noExplicitAny: テストコードでのモック型定義
  let db: ClientContract<any>

  beforeAll(() => {
    // インメモリ SQLite データベースを作成
    sqlite = new Database(':memory:')

    // テーブルを作成
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        userId TEXT NOT NULL
      );
    `)
  })

  beforeEach(() => {
    vi.clearAllMocks()

    // ZenStack クライアントを作成
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // biome-ignore lint/suspicious/noExplicitAny: テストスキーマの型キャスト
    const baseDb = new ZenStackClient(testSchema as any, {
      dialect: new SqliteDialect({ database: sqlite }),
    })

    // プラグインを適用
    db = baseDb.$use(
      createNextjsCachePlugin({
        defaultCacheLife: 'hours',
        excludeModels: ['Session'],
      }),
    )
  })

  afterAll(() => {
    sqlite?.close()
  })

  describe('User CRUD操作', () => {
    describe('Create', () => {
      it('ユーザーを作成できる', async () => {
        const userId = testId()

        const user = await db.user.create({
          data: {
            email: `test-${userId}@example.com`,
            id: userId,
            name: 'Test User',
          },
        })

        expect(user).toMatchObject({
          email: `test-${userId}@example.com`,
          id: userId,
          name: 'Test User',
        })
      })

      it('作成時にはキャッシュタグを設定しない', async () => {
        const userId = testId()

        await db.user.create({
          data: {
            email: `test-${userId}@example.com`,
            id: userId,
            name: 'Test User',
          },
        })

        // create は書き込み操作なのでcacheTagは呼ばれない
        expect(mockCacheTag).not.toHaveBeenCalled()
      })
    })

    describe('Read', () => {
      let testUserId: string

      beforeEach(async () => {
        // テストデータを事前に作成
        testUserId = testId()

        await db.user.create({
          data: {
            email: `read-test-${testUserId}@example.com`,
            id: testUserId,
            name: 'Read Test User',
          },
        })
        vi.clearAllMocks()
      })

      it('findUniqueでユーザーを取得できる', async () => {
        const user = await db.user.findUnique({
          where: { id: testUserId },
        })

        expect(user).toMatchObject({
          id: testUserId,
          name: 'Read Test User',
        })
      })

      it('findUnique時にキャッシュが設定される', async () => {
        await db.user.findUnique({
          where: { id: testUserId },
        })

        // unstable_cache が呼ばれて、タグ付きでキャッシュされることを確認
        expect(mockUnstableCache).toHaveBeenCalled()
        const lastCall = mockUnstableCache.mock.calls[0]
        const options = lastCall[2] as { tags: string[]; revalidate: number }
        expect(options.tags).toContain('user:list')
        expect(options.tags).toContain(`user:${testUserId}`)
        expect(options.revalidate).toBe(3600) // hours = 3600秒
      })

      it('findManyでユーザーを取得できる', async () => {
        const users = await db.user.findMany({
          where: { id: testUserId },
        })

        expect(users).toHaveLength(1)
        expect(users[0]).toMatchObject({
          id: testUserId,
          name: 'Read Test User',
        })
      })

      it('findMany時にキャッシュが設定される', async () => {
        await db.user.findMany({
          where: { id: testUserId },
        })

        // unstable_cache が呼ばれて、タグ付きでキャッシュされることを確認
        expect(mockUnstableCache).toHaveBeenCalled()
        const lastCall = mockUnstableCache.mock.calls[0]
        const options = lastCall[2] as { tags: string[]; revalidate: number }
        expect(options.tags).toContain('user:list')
        expect(options.revalidate).toBe(3600) // hours = 3600秒
      })

      it('countでユーザー数を取得できる', async () => {
        const count = await db.user.count({
          where: { id: testUserId },
        })
        expect(count).toBe(1)
      })

      it('Date型がキャッシュ後も維持される', async () => {
        const user = await db.user.findUnique({
          where: { id: testUserId },
        })

        // キャッシュ後もDate型が維持されている
        expect(user?.createdAt).toBeDefined()
        expect(user?.createdAt).toBeInstanceOf(Date)
      })
    })

    describe('Update', () => {
      let testUserId: string

      beforeEach(async () => {
        testUserId = testId()

        await db.user.create({
          data: {
            email: `update-test-${testUserId}@example.com`,
            id: testUserId,
            name: 'Update Test User',
          },
        })
        vi.clearAllMocks()
      })

      it('ユーザーを更新できる', async () => {
        const updated = await db.user.update({
          data: { name: 'Updated Name' },
          where: { id: testUserId },
        })

        expect(updated.name).toBe('Updated Name')
      })

      it('更新時にはキャッシュタグを設定しない', async () => {
        await db.user.update({
          data: { name: 'Updated Name' },
          where: { id: testUserId },
        })

        // update は書き込み操作なのでcacheTagは呼ばれない
        expect(mockCacheTag).not.toHaveBeenCalled()
      })
    })

    describe('Delete', () => {
      it('ユーザーを削除できる', async () => {
        const testUserId = testId()

        await db.user.create({
          data: {
            email: `delete-test-${testUserId}@example.com`,
            id: testUserId,
            name: 'Delete Test User',
          },
        })

        await db.user.delete({
          where: { id: testUserId },
        })

        const user = await db.user.findUnique({
          where: { id: testUserId },
        })

        expect(user).toBeNull()
      })
    })
  })

  describe('除外モデル（Session）の動作', () => {
    it('除外モデルはキャッシュタグを設定しない', async () => {
      // Session モデルの読み取りを試みる
      // 実際のデータがなくても findMany は空配列を返す
      await db.session.findMany({
        take: 1,
      })

      // Session は除外モデルなのでcacheTagは呼ばれない
      expect(mockCacheTag).not.toHaveBeenCalled()
    })
  })

  describe('キャッシュ無効化', () => {
    it('ユーザー作成後にonEntityMutationが呼ばれる設定になっている', () => {
      const plugin = createNextjsCachePlugin()
      expect(plugin.onEntityMutation).toBeDefined()
      expect(plugin.onEntityMutation?.afterEntityMutation).toBeDefined()
    })
  })
})
