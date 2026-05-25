/**
 * Fetches llms.txt files for project dependencies and caches them locally.
 * Skips fetch if the cached file is less than 24 hours old.
 * Run: deno task fetch-llms-docs
 */

const CACHE_DIR = new URL("../.claude/docs/", import.meta.url);
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const SOURCES: { url: string; file: string }[] = [
  { url: "https://eta.js.org/llms.txt", file: "eta.txt" },
];

async function isFresh(path: URL): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.mtime) return false;
    return Date.now() - stat.mtime.getTime() < MAX_AGE_MS;
  } catch {
    return false;
  }
}

await Deno.mkdir(CACHE_DIR, { recursive: true });

const results = await Promise.allSettled(
  SOURCES.map(async ({ url, file }) => {
    const cachePath = new URL(file, CACHE_DIR);

    if (await isFresh(cachePath)) {
      console.log(`${file} is fresh (< 24h old), skipping.`);
      return;
    }

    console.log(`Fetching ${url}...`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    await Deno.writeTextFile(cachePath, text);
    console.log(`Saved ${file} (${(text.length / 1024).toFixed(1)} KB)`);
  }),
);

const failed = results.filter((r) => r.status === "rejected");
if (failed.length > 0) {
  for (const f of failed) {
    console.error(`Failed:`, (f as PromiseRejectedResult).reason);
  }
  Deno.exit(1);
}
