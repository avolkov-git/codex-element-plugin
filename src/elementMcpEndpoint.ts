/** Compare loopback aliases without rewriting the actual transport address. */
export function elementMcpEndpointKey(value: string, transport = false): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())) return undefined;
    if (!(transport ? /^\/mcp\/?$/ : /^(?:\/|\/mcp\/?)?$/).test(url.pathname)) return undefined;
    return `${url.protocol}//loopback:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return undefined;
  }
}
