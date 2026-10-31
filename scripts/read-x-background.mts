import { chromium, type Page } from 'playwright'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const chromeRoot = join(homedir(), 'Library/Application Support/Google/Chrome')
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-x-background-'))
const profileRoot = join(tempRoot, 'profile')
const defaultRoot = join(profileRoot, 'Default')

interface TimelinePost {
  id: string
  url: string
  author: string
  handle: string
  text: string
  time: string
  truncated: boolean
}

async function prepareLoginState(): Promise<void> {
  await mkdir(defaultRoot, { recursive: true, mode: 0o700 })
  const cookieCopy = join(defaultRoot, 'Cookies')
  await copyFile(join(chromeRoot, 'Default/Cookies'), cookieCopy)
  await execFileAsync('/usr/bin/sqlite3', [
    cookieCopy,
    `DELETE FROM cookies
      WHERE host_key != 'x.com' AND host_key NOT LIKE '%.x.com'
        AND host_key != 'twitter.com' AND host_key NOT LIKE '%.twitter.com';
     VACUUM;`,
  ])
  const localState = JSON.parse(await readFile(join(chromeRoot, 'Local State'), 'utf8')) as {
    os_crypt?: unknown
  }
  await writeFile(
    join(profileRoot, 'Local State'),
    JSON.stringify(localState.os_crypt === undefined ? {} : { os_crypt: localState.os_crypt }),
    { mode: 0o600 },
  )
}

async function extractTimelinePosts(page: Page): Promise<TimelinePost[]> {
  return page.locator('article[data-testid="tweet"]').evaluateAll(articles => {
    const records: Array<{
      id: string
      url: string
      author: string
      handle: string
      text: string
      time: string
      truncated: boolean
    }> = []
    for (const article of articles) {
      const timeElement = article.querySelector('time')
      const timeLink = timeElement?.closest('a')
      const statusLinks = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
      const statusLink = timeLink ?? statusLinks.find(link => /^\/[^/]+\/status\/\d+(?:\/|$)/u.test(link.getAttribute('href') ?? ''))
      const href = statusLink?.getAttribute('href') ?? ''
      const match = href.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/u)
      if (match === null) continue
      const account = match[1]
      const id = match[2]
      const userName = article.querySelector('[data-testid="User-Name"]')
      const authorLink = Array.from(userName?.querySelectorAll<HTMLAnchorElement>('a') ?? [])
        .find(link => link.getAttribute('href') === `/${account}`)
      const textElement = article.querySelector<HTMLElement>('[data-testid="tweetText"]')
      const truncated = Array.from(article.querySelectorAll<HTMLElement>('a, [role="link"]'))
        .some(link => /^(?:Show more|显示更多|展开)$/u.test(link.textContent?.trim() ?? ''))
      records.push({
        id,
        url: `https://x.com/${account}/status/${id}`,
        author: authorLink?.textContent?.trim() ?? account,
        handle: `@${account}`,
        text: textElement?.innerText.trim() ?? '',
        time: timeElement?.getAttribute('datetime') ?? '',
        truncated,
      })
    }
    return records
  })
}

async function readFullPost(page: Page, post: TimelinePost): Promise<void> {
  await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 30000 })
  await delay(500)
  const fullPost = (await extractTimelinePosts(page)).find(candidate => candidate.id === post.id)
  if (fullPost === undefined) throw new Error(`Could not independently read ${post.url}`)
  post.author = fullPost.author
  post.handle = fullPost.handle
  post.text = fullPost.text
  post.time = fullPost.time
  post.truncated = fullPost.truncated
}

let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
try {
  await prepareLoginState()
  const { stdout: versionOutput } = await execFileAsync(chromeExecutable, ['--version'])
  const chromeVersion = versionOutput.match(/(\d+(?:\.\d+)+)/u)?.[1]
  if (chromeVersion === undefined) throw new Error('Could not determine the installed Chrome version')
  context = await chromium.launchPersistentContext(profileRoot, {
    executablePath: chromeExecutable,
    headless: true,
    viewport: { width: 1440, height: 1200 },
    locale: 'zh-CN',
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    ignoreDefaultArgs: ['--use-mock-keychain'],
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 30000 })

  const posts = new Map<string, TimelinePost>()
  let unchangedRounds = 0
  for (let round = 0; round < 40 && posts.size < 10; round += 1) {
    const previousSize = posts.size
    for (const post of await extractTimelinePosts(page)) {
      if (!posts.has(post.id)) posts.set(post.id, post)
    }
    if (posts.size >= 10) break
    unchangedRounds = posts.size === previousSize ? unchangedRounds + 1 : 0
    if (unchangedRounds >= 5) break
    await page.evaluate(() => window.scrollBy(0, Math.max(700, window.innerHeight * 0.85)))
    await delay(1400)
  }

  const selected = Array.from(posts.values()).slice(0, 10)
  const detailPage = await context.newPage()
  for (const post of selected) await readFullPost(detailPage, post)
  await detailPage.close()

  console.log(JSON.stringify({
    count: selected.length,
    complete: selected.length === 10,
    execution: 'isolated_headless_chrome',
    interactions: ['navigate', 'scroll', 'extract'],
    posts: selected.map(({ truncated: _truncated, ...post }, index) => ({ index: index + 1, ...post })),
  }, null, 2))
} finally {
  await context?.close()
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
