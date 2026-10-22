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
  const url = new URL("active-host.json", base);
  url.searchParams.set("t", String(Date.now()));
  const response = await request(url.href, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error("The primary host address is unavailable. Try again shortly.");
  return parseHostRecord(await response.json()).url;
}
