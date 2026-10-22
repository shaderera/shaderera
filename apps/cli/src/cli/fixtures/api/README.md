# The films API's contract fixtures

What the CLI (`login`, `whoami`, `logout`, `share`, `fork`) sends to the films API
(`https://api.shaderera.com/api/v1`) and what it reads back, one exchange per file. The API's own
description is `apps/web/API.md` in shaderera/shaderera.com. These files are the part of it that
both sides test against, so that the CLI's fake API and the films app cannot drift apart
(shaderera/shaderera#214, shaderera/shaderera.com#181).

- **The CLI** checks its client code against them: `../../api-contract.test.ts` runs `call`,
  `healthOf`, login, whoami, logout, share's `send` and fork against a fake API that answers only
  from these files, and checks each request it sent.
- **The films app** (shaderera/shaderera.com, `apps/web`) copies this folder at a pinned commit of
  this repo, and its tests send each fixture's request to the API and check the answer against the
  fixture. A change here reaches it only when it moves the pin.

Changing a file here changes the contract: the films app must answer it before the CLI relies on
it.

## A fixture

```jsonc
{
  "route": "POST /films/{film}/versions", // the route under /api/v1; {name} is a path part
  "about": "…",                            // when the CLI sends it
  "request": {
    "method": "POST",
    "path": "/films/2phicdywpg/versions",  // an example of the route
    "headers": { "Authorization": "Bearer …", "Content-Type": "application/json" },
    "body": { … },                         // a JSON body: an example of its shape
    "bytes": "…",                          // or raw bytes, as UTF-8 text
    "size": 5242881                        // or raw bytes given by their length only
  },
  "response": { "status": 201, "headers": { … }, "body": { … } },
  "records": ["request.body.files"],       // places whose keys are data (path → sha256)
  "optional": ["response.body.url"]        // places that may be absent or null
}
```

`contract.ts` holds the rules (`shapeErrors`, `headerErrors`, `requestErrors`, `responseErrors`)
and loads the files (`loadFixtures`). It imports only `node:fs` and `node:path`, so the films app
runs the same file:

- **The status** is the fixture's.
- **A body** has the example's JSON types. An object has every field the example has; more
  fields are allowed, since v1 only adds. An array's items are each shaped like the example's
  first. A record may have any keys, each value shaped like the example's first. An `optional`
  place may be absent or null, and an example's `null` matches anything. Values are examples,
  never compared: ids, times and hashes differ between runs.
- **Headers** named in the fixture are present (`null`: absent). A `Content-Type` has the same
  media type, and a value that is a whole number in the example (`Retry-After`) is one too.
- **Bytes** in an `/obj/{sha}` fixture hash to that sha.

## What the CLI sends on every request

`User-Agent: shaderera/<version>`. The API answers `426` (`error-426.json`) when that version is
older than it takes, and only then: a request without it is never refused for it. The CLI does
not send it yet: its test in `api-contract.test.ts` is a todo until `site.ts` does.
