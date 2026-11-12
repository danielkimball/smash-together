// Old hosts write server.json. This record keeps the selected host independent.
export function parseHostRecord(record) {
  if (
    record?.version !== 1 ||
    !/^[a-z0-9][a-z0-9-]{1,63}$/.test(record.hostId || "") ||
    !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(record.publisher || "")
  )
    throw Error("The primary host record is invalid.");
  const url = new URL(record.url);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Invalid live host address.");
  return { ...record, url: url.origin };
}

export async function discoverHost(base, request = fetch) {
  const page = new URL(base);
  const urls = [new URL("active-host.json", page)];
  // A tunnel can rotate while Pages is still building. The committed registry
  // already names the verified host; do not wait for a static-site deployment
  // to discover it. This is the same owner-guarded record, never a backup host.
  const owner = /^([a-z0-9-]+)\.github\.io$/i.exec(page.hostname)?.[1];
  const repo = page.pathname.split("/").filter(Boolean)[0];
  if (owner && repo && /^[a-z0-9_.-]+$/i.test(repo))
    urls.unshift(
      new URL(
        `https://raw.githubusercontent.com/${owner}/${repo}/gh-pages/active-host.json`,
      ),
    );
  for (const [index, url] of urls.entries()) {
    url.searchParams.set("t", String(Date.now()));
    try {
      const response = await request(url.href, {
        cache: "no-store",
        signal: AbortSignal.timeout(index < urls.length - 1 ? 5000 : 15000),
      });
      if (!response.ok)
        throw Error(
          "The primary host address is unavailable. Try again shortly.",
        );
      return parseHostRecord(await response.json()).url;
    } catch (error) {
      if (index === urls.length - 1) throw error;
    }
  }
}
