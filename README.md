# Next.js Cache Plugin for ZenStack v3

ZenStack v3 のランタイムプラグインとして、Next.js のキャッシュシステム（`unstable_cache`）を透過的に統合するプラグインです。

## 特徴

- **透過的なキャッシュ**: 開発者がキャッシュを意識する必要がない
- **unstable_cache によるキャッシュ**: 読み取り操作で自動的に `unstable_cache` でラップ
- **自動キャッシュ無効化**: 書き込み操作後に自動的に `revalidateTag()` を実行
- **Date型の自動変換**: キャッシュシリアライズ問題を自動で解決

## アーキテクチャ

```
開発者のコード
    │
    ▼
┌────────────────────────────────┐
│  db.user.findMany()            │  ← 普通にORMを使うだけ
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  onQuery Hook (読み取り)        │
│  ・unstable_cache でラップ       │
│  ・キャッシュタグ・revalidate設定 │
│  ・Date → ISO文字列変換          │
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  afterEntityMutation (書き込み) │
│  ・revalidateTag() で自動無効化  │
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  Next.js Cache                  │
│  ・unstable_cache による処理    │
└────────────────────────────────┘
```

## 使い方

### 基本的な使い方

```typescript
// src/lib/prisma.ts
import { ZenStackClient } from '@zenstackhq/orm';
import { createNextjsCachePlugin } from '@/lib/plugins';

const baseDb = new ZenStackClient(schema, { dialect });

// プラグインを適用
const db = baseDb.$use(
  createNextjsCachePlugin({
    defaultCacheLife: 'hours',
    excludeModels: ['Session', 'Verification'],
    debug: true,
  })
);

export { db };
```

### Server Actions での使用

キャッシュを意識する必要はありません。普通にORMを使うだけです。

```typescript
// src/actions/user.ts
'use server';

import { db } from '@/lib/db';

// 読み取り: 自動的にキャッシュされる
export async function getUsers() {
  return db.user.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

// 読み取り: 個別エンティティも自動キャッシュ
export async function getUser(id: string) {
  return db.user.findUnique({
    where: { id },
  });
}

// 書き込み: 自動的にキャッシュが無効化される
export async function updateUser(id: string, data: { name: string }) {
  return db.user.update({
    where: { id },
    data,
  });
  // afterEntityMutation で以下が自動実行:
  // - revalidateTag('user:list', 'max')
  // - revalidateTag('user:${id}', 'max')
}
```

## オプション

| オプション | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `defaultCacheLife` | `'seconds' \| 'minutes' \| 'hours' \| 'days' \| 'weeks' \| 'max'` | `'hours'` | デフォルトのキャッシュ有効期間（revalidate秒数に変換） |
| `excludeModels` | `string[]` | `['Session', 'Account', 'Verification']` | キャッシュから除外するモデル |
| `debug` | `boolean` | `false` | デバッグログを出力 |
| `customTagGenerator` | `(model: string, id?: string) => string[]` | - | カスタムのキャッシュタグ生成関数 |

### キャッシュ有効期間

`defaultCacheLife` の値は以下の秒数に変換されます：

| 値 | 秒数 |
|------|------|
| `'seconds'` | 1 |
| `'minutes'` | 60 |
| `'hours'` | 3600 |
| `'days'` | 86400 |
| `'weeks'` | 604800 |
| `'max'` | 31536000（1年） |

## キャッシュタグの命名規則

デフォルトでは以下の形式でキャッシュタグが生成されます：

- リスト取得: `{model}:list` (例: `user:list`)
- 個別取得: `{model}:{id}` (例: `user:abc123`)

### カスタムタグ生成

```typescript
createNextjsCachePlugin({
  customTagGenerator: (model, id) => {
    const tags = [`v1:${model.toLowerCase()}:list`];
    if (id) {
      tags.push(`v1:${model.toLowerCase()}:${id}`);
    }
    return tags;
  },
});
```

## 注意事項

### 1. Server Components / Server Actions 内でのみ有効

`unstable_cache` と `revalidateTag()` は Server 環境でのみ有効です。
クライアントコンポーネントからの直接呼び出しでは無視されます。

### 2. Date型の扱い

プラグインは自動的に Date 型を ISO 8601 文字列に変換します。
クライアント側で Date オブジェクトとして使う場合は `new Date(string)` で復元してください。

```typescript
// クライアント側
const user = await getUser(id);
const createdAt = new Date(user.createdAt); // 文字列から復元
```

### 3. キャッシュキーの生成

`unstable_cache` のキャッシュキーは `model:operation` と引数のJSON文字列から生成されます。
同じ引数で同じ操作を行う場合、キャッシュがヒットします。

## フック一覧

| フック | 説明 |
|-------|------|
| `onQuery` | ORM操作をインターセプト。読み取り操作でキャッシュタグを設定 |
| `mutationInterceptionFilter` | ミューテーションの事前フィルタリング |
| `afterEntityMutation` | ミューテーション後にキャッシュを無効化 |

## 対応する操作

### 読み取り操作（キャッシュ適用）

- `findMany`
- `findUnique`
- `findFirst`
- `findUniqueOrThrow`
- `findFirstOrThrow`
- `count`
- `aggregate`
- `groupBy`

### 書き込み操作（キャッシュ無効化）

- `create`
- `createMany`
- `update`
- `updateMany`
- `delete`
- `deleteMany`
- `upsert`
