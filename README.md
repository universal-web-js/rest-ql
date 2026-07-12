# RestQL

RestQL is a powerful and flexible library that allows you to query REST APIs using a GraphQL-like syntax.
It provides a seamless way to interact with REST endpoints, offering features like batched queries, caching, and data transformation.

## Features
- **Intuitive Syntax**: RestQL offers a clear and precise syntax, enabling developers to articulate their data requirements succinctly.
- **Built-in Types for Data Structures**: RestQL includes robust type definitions that operate at runtime, ensuring accurate data transformations and minimizing the risk of type-related errors
- **Structured API Definition**: With support for a well-defined API schema, RestQL facilitates a more organized and maintainable codebase.
- **Batch Processing**: By allowing the execution of multiple requests in a single operation, RestQL significantly reduces network latency and server load.
- **Advanced Caching Mechanisms**: The library incorporates efficient caching strategies, optimizing both time and resource utilization.
- **Data Transformation**: Custom transformations can be applied to tailor the retrieved data to specific application needs.
- **Type Safety**: With TypeScript support, RestQL ensures type safety, reducing runtime errors and enhancing code reliability

## Installation

```bash
npm install lib-restql
```

or

```bash
yarn add lib-restql
```

## Schema Definition Language (SDL)
RestQL uses an SDL to define the structure of your API.

### Type Definitions
```typescript
  type ResourceName {
    field: FieldType @directive
    ...
  }
```
- **ResourceName**: Corresponds to a REST resource (e.g., User, Post)
- **field**: Represents a property of the resource
- **FieldType**: Can be scalar (String, Int, Boolean, etc.) or another defined type


### Directives
```typescript
  type User {
    id: String @from("user_id") @transform("transformUserId")
    name: String @from("full_name")
    email: String @from("contact_info.email")

    @endpoint(GET, "/users", "data.data[0]")
    @endpoint(POST, "/users", "data.data[0]")
  }
```
- **@from("api_field_name")**: Maps the field to a different name in the API response
- **@transform("transformerName")**: Applies a custom transformation to the field
- **@endpoint(METHOD, "path", "dataPath")**: Defines REST endpoint for the resource

### Query Language
Basic Query Structure
```typescript
query QueryName {
  resource {
    field1
    field2
    nestedResource {
      nestedField1
    }
  }
}
```

### Query with Arguments
```typescript
query QueryName($arg: Type) {
  resource(id: $arg) {
    field1
    field2
  }
}
```

### Multiple Resources in One Query
```typescript
query GetMultipleResources {
  resource1 {
    field1
  }
  resource2 {
    field2
  }
}
```

### Mutation Language
Basic Mutation Structure
```typescript
mutation MutationName($arg: Type) {
  action(input: $arg) {
    resultField1
    resultField2
  }
}
```

Example:
```typescript
mutation CreateUser($name: String!, $email: String!) {
  createUser(name: $name, email: $email) {
    id
    name
    email
  }
}
```

### Nested Data Retrieval
RestQL automatically handles nested data structures:
```typescript
query GetUserWithPosts {
  user {
    name
    posts {
      title
      comments {
        text
      }
    }
  }
}
```

### Array Fields
Use square brackets to denote array fields:
```typescript
type User {
  hobbies: [String]
  friends: [User]
}
```

Nested Arrays:
```typescript
type User {
  hobbies: [String]
  friends: [[User]]
}
```

### Custom Transformers
Define custom transformers in your RestQL initialization:

```javascript
const transformers = {
  transformUserId: (originalData, shapedData) => ({
    ...shapedData,
    id: `custom_${shapedData.id}`
  })
};
```

### Execution
Execute queries using the RestQL instance:

```javascript
const result = await restql.execute(queryString, variables, options);
```

- **queryString**: The RestQL query or mutation
- *variables**: Object containing any variable values
- **options**: Additional options like { useCache: true }


## Quick Start

```typescript
import { RestQL } from "lib-restql";

// Define the SDL
const sdl = `
  type User {
    id: String @from("user_id") @transform("transformUserId")
    name: String @from("full_name")
    email: String @from("contact_info.email")
    address: Address @from("location")
    hobbyList: [Hobby] @from("hobbies")
    posts: Post

    @endpoint(GET, "/users", "data.data[0]")
    @endpoint(POST, "/users", "data.data[0]")
    @endpoint(PUT, "/users", "data.data[0]")
    @endpoint(PATCH, "/users", "data.data[0]")
    @endpoint(DELETE, "/users", "data")
  }

  type Post {
    id: String @from("post_id")
    name: String @from("post_name")

    @endpoint(GET, "/posts", "data.data[0]")
    @endpoint(POST, "/posts", "data.data[0]")
    @endpoint(PUT, "/posts", "data.data[0]")
    @endpoint(PATCH, "/posts", "data.data[0]")
    @endpoint(DELETE, "/posts", "data")
  }

  type Address {
    street: String @from("street_name")
    city: String
    country: Country @from("country")
  }

  type Country {
    name: String @from("country_name")
    capital: String @from("capital_name")
    blockList: [[Block]] @from("blocks")
  }

  type Block {
    name: String @from("block_name")
    number: String @from("block_number")
  }

  type Hobby {
    name: String @from("hobby_name")
    id: String @from("hobby_id")
  }
`;

// Define base URLs
const baseUrls = {
  default: "https://api.example.com",
  // "/users": "https://users.api.example.com" // optional
};

// Define options
const options = {
  cacheTimeout: 300000, // 5 minutes
  headers: {
    Authorization: "Bearer your-token-here"
  },
  maxRetries: 3,
  retryDelay: 1000,
  batchInterval: 50
};

// Define transformers
const transformers = {
  transformUserId: (originalData: any, shapedData: any) => {
    return {
      ...shapedData,
      id: `(ID: ${shapedData.id})`
    };
  }
};

// Initialize RestQL
const restql = new RestQL(sdl, baseUrls, options, transformers);

// Define one or many queries
const query = `
  query GetUserWithPosts($userId: String!, $postLimit: Int) {
    user(userId: $userId) {
      id
      name
      email
      parkName
      hobbyList {
        id
        name
      }
      address {
        street
        city
        country {
          name
          capital
          blockList {
            name
            number
            parkList {
              parkName
              parkId
            }
          }
        }
      }
      posts(postLimit: $postLimit) {
        id
        name
        searchResult {
          searchDesc
          searchType
        }
      }
    }
  }
`;

// Execute the query
async function executeQuery() {
  try {
    const result = await restql.execute(query, {
      userId: "123",
      postLimit: 5,
    }, { useCache: true });
    console.log("Query result:", result);

    // Caching
    const resultCached = await restql.execute(query, {}, { useCache: true });
    console.log("Query result cached:", resultCached);
  } catch (error) {
    console.error("Error executing query:", error);
  }
}

executeQuery();
```

## Advanced Usage

### Mutations

```typescript
const batchedMutations = `
  mutation CreateUsers($name: String!, $email: String!) {
    createUser(name: $name, email: $email) {
      id
      name
      email
      address {
        street
        city
        country {
          name
          capital
          blockList {
            name
            number
          }
        }
      }
      hobbyList {
        name
        id
      }
    }
    createUser(name: $name, email: $email) {
      id
      name
      email
    }
  }
`;

async function createUsers() {
  try {
    const result = await restQL.execute(batchedMutations, { name1: 'name_1', emai1: 'email_1', name2: 'name_2', email2: 'email_2' });
    console.log('Created users:', result);
  } catch (error) {
    console.error('Error creating user:', error);
  }
}
```

## Data Mapping Example

RestQL excels at mapping complex REST API responses to the structure defined in your GraphQL-like queries. Here's an example of how RestQL transforms API data:

### API Responses

**Users API Response:**
```json
{
  "data": {
    "data": [
      {
        "user_id": 1,
        "full_name": "test_full_name",
        "contact_info": {
          "email": "mohdsidani@gmail.com"
        },
        "location": {
          "street_name": "test_street_name",
          "city": "test_city",
          "country": {
            "country_name": "test_country_name",
            "capital_name": "test_capital",
            "blocks": [
              [{
                "block_name": "test_block_name_1",
                "block_number": "test_block_number_1"
              }, {
                "block_name": "test_block_name_2",
                "block_number": "test_block_number_2"
              }]
            ]
          }
        },
        "hobbies": [
          {
            "hobby_name": "kate",
            "hobby_id": 1
          }
        ]
      }
    ]
  }
}
```

**Posts API Response:**
```json
{
  "data": {
    "data": [
      {
        "post_id": 1,
        "post_name": 1
      }
    ]
  }
}
```

**RestQL Query:**
```graphql
query {
  user {
    id
    name
    email
    address {
      street
      city
      country {
        name
        capital
        blockList {
          name
          number
        }
      }
    }
    hobbyList {
      name
      id
    }
  }
  post {
    id
    name
  }
}
```

**Resulting Data Structure:**
```json
{
  "post": {
    "id": 1,
    "name": 1
  },
  "user": {
    "id": "idddd_shapedData_1",
    "name": "test_full_name",
    "email": "mohdsidani@gmail.com",
    "address": {
      "street": "test_street_name",
      "city": "test_city",
      "country": {
        "name": "test_country_name",
        "capital": "test_capital",
        "blockList": [
          [
            {
              "name": "test_block_name_1",
              "number": "test_block_number_1"
            },
            {
              "name": "test_block_name_2",
              "number": "test_block_number_2"
            }
          ]
        ]
      }
    },
    "hobbyList": [
      {
        "name": "kate",
        "id": 1
      }
    ]
  }
}
```

## Documentation
WIP

## Contributing
We welcome contributions! Please see our contributing guidelines for more details.

## License
RestQL is MIT licensed.
This markdown provides an introduction to your RestQL project, highlighting its key features, providing a quick start guide, and showing some advanced usage examples. You may want to adjust the content based on the specific details of your implementation, add more examples, or include additional sections as needed.

Remember to create the referenced files like `CONTRIBUTING.md` and `LICENSE`, and replace `link-to-your-docs` with the actual link to your documentation if you have one.

---

# RestQL v2 (preview) — One IR, Three Producers

> **RestQL v2 has no query language to learn. The query language is a compiler target.**

v2 replaces string-based queries with a compiled execution model: you describe data
relationships, the planner computes a parallel execution graph, and the executor runs
it with automatic deduplication and partial-failure semantics.

```
Typed Builder ──┐
AI Codegen ─────┼──▶  IR (JSON graph)  ──▶  Planner  ──▶  Executor  ──▶  Typed Result
OpenAPI Import ─┘        validated           waves         dedup
```

## Quickstart

```ts
import { query, http, from, plan, execute, fetchTransport } from 'lib-restql/v2'

const built = query()
  .node('user',          http.get('/users/{id}', { id: 1 }))
  .node('orders',        http.get('/users/{userId}/orders').bind('userId', from('user', 'id')))
  .node('cart',          http.get('/users/{userId}/cart').bind('userId', from('user', 'id')))
  .node('notifications', http.get('/users/{userId}/notifications').bind('userId', from('user', 'id')))
  .node('payments',      http.get('/orders/{orderId}/payments').bind('orderId', from('orders', 'items[0].id')))
  .build()                       // → validated IR; a builder can never emit an invalid graph

if (built.ok) {
  const planned = plan(built.value)              // → waves: [[user], [cart, notifications, orders], [payments]]
  if (planned.ok) {
    const result = await execute(planned.value, built.value, fetchTransport())
    // result.nodes.orders → { status: 'ok', data: ... } | { status: 'error' } | { status: 'skipped' }
    // result.meta         → { dedupedRequests, waves }
  }
}
```

No `Promise.all`. No manual dependency ordering. Dependency edges are derived from
`bind()` calls; independent nodes run concurrently; identical in-flight requests are
deduplicated; a failed node marks its dependents `skipped` while siblings succeed.

## Architecture

| Module | Responsibility |
|---|---|
| `src/v2/ir` | The IR: a flat, versioned, JSON-serializable node map with explicit `dependsOn` edges. `validate(unknown)` returns `Result`, never throws, collects all errors in one pass. |
| `src/v2/plan` | Pure planner (Kahn's algorithm): IR → deterministic waves. Cycles are reported, never hung on. |
| `src/v2/exec` | Wave executor: in-flight dedup keyed by `method + url`, binding resolution (`items[0].id` paths), partial success, abort signals. `Transport` is the **only** seam that touches the network. |
| `src/v2/builder` | Immutable fluent builder. Constructs IR and nothing else — zero execution logic. |

The IR is deliberately a *flat map with edges*, not a nested tree: trees cannot express
diamond dependencies (`a → b,c → d`). Full design rationale, invariants, and the
phased plan live in [`docs/rfc/rfc-0002-v2-core.md`](./docs/rfc/rfc-0002-v2-core.md).

## Benchmarks

Real `node:http` server, real `fetch`, 25 ms simulated latency per request,
15 iterations + warmup. Run them yourself: `npm run bench`.

**Profile page** — `user → (orders, cart, notifications)`, `orders → payments`:

| Contender | p50 | Server-observed concurrency |
|---|---|---|
| Native fetch, naive sequential | 130.7 ms | 1 |
| RestQL **v1** engine | 132.6 ms | 1 |
| Native fetch, hand-optimized `Promise.all` | 79.7 ms | 3 |
| RestQL **v2** engine | **79.9 ms** | 3 |

v2 matches hand-optimized native fetch within noise (**+0.2 ms**) — you stop writing
orchestration without paying for the abstraction. Engine overhead above the theoretical
floor (waves × latency) is ~5 ms.

**Breadth scaling** — K independent resources under `user`:

| K | v1 p50 | v2 p50 | speedup |
|---|---|---|---|
| 2 | 81.3 ms | 52.7 ms | 1.5× |
| 4 | 132.4 ms | 53.4 ms | 2.5× |
| 6 | 184.7 ms | 55.4 ms | 3.3× |

v1 resolves nested resources serially (O(K)); v2 stays at two waves regardless of K.
**Dedup:** 6 nodes sharing one upstream → 1 network request (83% saved; v1 has no
in-flight dedup).

## Tests & build

- `npm test` — 46 tests: 13 v1 characterization tests (lock existing behavior, quirks included), 28 v2 unit tests (IR / planner / executor / builder), 5 pre-existing BatchManager tests.
- `npm run test:v2:types` — v2 under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- `npm run build:v2` — emits `dist/v2` with declarations.
- **Zero regressions:** no v1 source file is modified. Note: `npm run build` (v1) has 29 pre-existing type errors on master, unchanged by this work; v1 behavior is pinned by the characterization suite.
