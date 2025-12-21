# Next.js Cache Plugin for ZenStack v3

A runtime plugin for ZenStack v3 that transparently integrates the Next.js cache system (`unstable_cache`).

## Features

- **Transparent Caching**: Developers do not need to be conscious of caching mechanisms.
- **Caching via `unstable_cache`**: Read operations are automatically wrapped in `unstable_cache`.
- **Automatic Invalidation**: `revalidateTag()` is automatically executed after write operations.
- **Automatic Date Conversion**: Automatically resolves cache serialization issues for Date types.

## Architecture

```
Developer Code
    │
    ▼
┌────────────────────────────────┐
│  db.user.findMany()            │  ← Simply use the ORM
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  onQuery Hook (Read)           │
│  ・Wrap in unstable_cache      │
│  ・Set Cache Tags / Revalidate │
│  ・Date → ISO String Convert   │
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  afterEntityMutation (Write)   │
│  ・Auto invalidate via         │
│    revalidateTag()             │
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  Next.js Cache                 │
│  ・Process via unstable_cache  │
└────────────────────────────────┘
```

## Usage

### Basic Usage

```typescript
// src/lib/prisma.ts
import { ZenStackClient } from '@zenstackhq/orm';
import { createNextjsCachePlugin } from '@/lib/plugins';

const baseDb = new ZenStackClient(schema, { dialect });

// Apply the plugin
const db = baseDb.$use(
  createNextjsCachePlugin({
    defaultCacheLife: 'hours',
    excludeModels: ['Session', 'Verification'],
    debug: true,
  })
);

export { db };
```

### Usage in Server Actions

You don't need to worry about caching manually. Just use the ORM as you normally would.

```typescript
// src/actions/user.ts
'use server';

import { db } from '@/lib/db';

// Read: Automatically cached
export async function getUsers() {
  return db.user.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

// Read: Individual entities are also automatically cached
export async function getUser(id: string) {
  return db.user.findUnique({
    where: { id },
  });
}

// Write: Automatically invalidates the cache
export async function updateUser(id: string, data: { name: string }) {
  return db.user.update({
    where: { id },
    data,
  });
  // The following are automatically executed in afterEntityMutation:
  // 
  // - updateTag('user:list')
  // - updateTag('user:${id}')
}
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultCacheLife` | `'seconds' \| 'minutes' \| 'hours' \| 'days' \| 'weeks' \| 'max'` | `'hours'` | Default cache duration (converted to revalidate seconds). |
| `excludeModels` | `string[]` | `['Session', 'Account', 'Verification']` | Models to exclude from caching. |
| `debug` | `boolean` | `false` | Outputs debug logs. |
| `customTagGenerator` | `(model: string, id?: string) => string[]` | - | Function to generate custom cache tags. |

### Cache Duration

The values for `defaultCacheLife` are converted into the following seconds:

| Value | Seconds |
|---|---|
| `'seconds'` | 1 |
| `'minutes'` | 60 |
| `'hours'` | 3600 |
| `'days'` | 86400 |
| `'weeks'` | 604800 |
| `'max'` | 31536000 (1 Year) |

## Cache Tag Naming Convention

By default, cache tags are generated in the following format:

- List retrieval: `{model}:list` (e.g., `user:list`)
- Individual retrieval: `{model}:{id}` (e.g., `user:abc123`)

### Custom Tag Generation

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

## Caveats

### 1. Valid Only in Server Components / Server Actions

`unstable_cache` and `revalidateTag()` are only valid in a Server environment. Calls made directly from Client Components will be ignored.

### 2. Handling Date Types

The plugin automatically converts `Date` types to ISO 8601 strings. If you need to use them as Date objects on the client side, please restore them using `new Date(string)`.

```typescript
// Client-side
const user = await getUser(id);
const createdAt = new Date(user.createdAt); // Restore from string
```

### 3. Cache Key Generation

The cache key for `unstable_cache` is generated from `model:operation` and the JSON string of the arguments. If the same operation is performed with the same arguments, the cache will be hit.

## Hooks List

| Hook | Description |
|---|---|
| `onQuery` | Intercepts ORM operations. Sets cache tags for read operations. |
| `mutationInterceptionFilter` | Pre-filtering for mutations. |
| `afterEntityMutation` | Invalidates cache after mutations. |

## Supported Operations

### Read Operations (Cache Applied)

- `findMany`
- `findUnique`
- `findFirst`
- `findUniqueOrThrow`
- `findFirstOrThrow`
- `count`
- `aggregate`
- `groupBy`

### Write Operations (Cache Invalidated)

- `create`
- `createMany`
- `update`
- `updateMany`
- `delete`
- `deleteMany`
- `upsert`
