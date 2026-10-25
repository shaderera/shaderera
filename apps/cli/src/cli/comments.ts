import { parseArgs } from 'node:util'
import { findProject } from '../node/project.ts'
import {
  addComment,
  type Box,
  type CommentState,
  type Listing,
  listing,
  type Point,
  replyTo,
  setState,
  type Thread,
  waitForComments,
} from '../project/comments.ts'
import type { By } from '../project/revisions.ts'
import { EXIT } from './findings.ts'

const USAGE = `Usage: shaderera comments [list] [--state open|fixed|resolved|all] [--json]
       shaderera comments show <id> [--json]
       shaderera comments add --at <t>[-<t2>] [--variant v] [--point x,y | --box x,y,w,h] <text>
       shaderera comments reply <id> [--fixed] <text>
       shaderera comments resolve <id> | reopen <id>
       shaderera comments --wait [--json]`

/** The CLI never writes as the person: only the studio page does (decision 0025). */
const BY: By = 'cli'

const numbers = (v: string | undefined, n: number, flag: string) => {
  if (v === undefined) return undefined
  const xs = v.split(',').map(Number)
  if (xs.length !== n || xs.some((x) => !Number.isFinite(x)))
    throw new Error(`--${flag} is ${n} numbers in frame pixels, comma-separated.`)
  return xs
}

const when = (c: Thread) =>
  `${c.t} s (frame ${c.frame})${c.to !== undefined ? ` to ${c.to} s (frame ${c.toFrame})` : ''}`
const where = (c: Thread) =>
  [
    c.variant ? `variant ${c.variant}` : '',
    c.point ? `at ${c.point.join(',')}` : '',
    c.box ? `box ${c.box.join(',')}` : '',
    c.object ? `object ${c.object}` : '',
  ]
    .filter(Boolean)
    .join(', ')

const line = (c: Listing['comments'][number]) =>
  `${c.id}  ${c.state.padEnd(8)} ${when(c)}${where(c) ? `  ${where(c)}` : ''}  ${c.by}: ${c.text.split('\n')[0]}${c.replies.length ? `  (${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'})` : ''}${c.stale ? '  [stale]' : ''}`

const thread = (c: Listing['comments'][number]) => {
  console.log(line(c))
  console.log(
    `  revision ${c.revision}${c.fixedIn ? `, fixed in ${c.fixedIn}` : ''}${c.stale ? ' (the tree has changed since)' : ''}`,
  )
  console.log(`  ${c.text.split('\n').join('\n  ')}`)
  for (const r of c.replies)
    console.log(
      `  ${r.at}  ${r.by}${r.fixed ? ' (fixed)' : ''}: ${r.text.split('\n').join('\n    ')}`,
    )
}

/**
 * `shaderera comments`: the comments on the film (decision 0025): list, show, add, reply (with
 * `--fixed`, which saves the fix as a revision), resolve, reopen, and `--wait` for the next one.
 * `--json` prints what MCP `comments` gives: `{revision, head, comments}`.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      state: { type: 'string' },
      json: { type: 'boolean' },
      wait: { type: 'boolean' },
      at: { type: 'string' },
      variant: { type: 'string' },
      point: { type: 'string' },
      box: { type: 'string' },
      fixed: { type: 'boolean' },
    },
  })
  const { root } = await findProject(v.root ?? process.cwd())
  const [what = 'list', ...rest] = positionals
  const print = (l: Listing, one = false) => {
    if (v.json) console.log(JSON.stringify(l, null, 2))
    else if (l.comments.length === 0) console.log('No comments.')
    else for (const c of l.comments) (one ? thread : (x: typeof c) => console.log(line(x)))(c)
  }
  const id = () => {
    const x = rest[0]
    if (!x) throw new Error(`comments ${what} needs a comment id.\n${USAGE}`)
    return x
  }
  const text = (from: number) => {
    const t = rest.slice(from).join(' ')
    if (!t) throw new Error(`comments ${what} needs its text.\n${USAGE}`)
    return t
  }

  if (v.wait) {
    const stop = new AbortController()
    for (const s of ['SIGINT', 'SIGTERM'] as const)
      process.once(s, () => {
        stop.abort()
        process.exit(130)
      })
    if (!v.json) console.error('waiting for a comment…')
    print(await waitForComments(root, { signal: stop.signal }))
    return EXIT.ok
  }
  switch (what) {
    case 'list':
      print(listing(root, { state: (v.state ?? 'open') as CommentState | 'all' }))
      return EXIT.ok
    case 'show':
      print(listing(root, { id: id() }), true)
      return EXIT.ok
    case 'add': {
      if (!v.at) throw new Error(`comments add needs --at <t> or --at <t>-<t2>.\n${USAGE}`)
      const m = /^([0-9.]+)(?:-([0-9.]+))?$/.exec(v.at)
      if (!m) throw new Error(`--at is <t> or <t>-<t2> in seconds, not ${v.at}.`)
      const c = await addComment(
        root,
        {
          t: Number(m[1]),
          ...(m[2] !== undefined ? { to: Number(m[2]) } : {}),
          ...(v.variant !== undefined ? { variant: v.variant } : {}),
          ...(v.point ? { point: numbers(v.point, 2, 'point') as Point } : {}),
          ...(v.box ? { box: numbers(v.box, 4, 'box') as Box } : {}),
          text: positionals.slice(1).join(' '),
        },
        BY,
      )
      print(listing(root, { id: c.id }), true)
      return EXIT.ok
    }
    case 'reply': {
      const c = await replyTo(root, id(), text(1), { by: BY, fixed: v.fixed === true })
      print(listing(root, { id: c.id }), true)
      return EXIT.ok
    }
    case 'resolve':
    case 'reopen': {
      const c = await setState(root, id(), what === 'resolve' ? 'resolved' : 'open', BY)
      print(listing(root, { id: c.id }), true)
      return EXIT.ok
    }
    default:
      throw new Error(`No comments ${what}.\n${USAGE}`)
  }
}
