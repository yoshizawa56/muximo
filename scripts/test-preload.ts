// Local servers used by tests must bypass any ambient HTTP(S)_PROXY settings,
// otherwise proxied environments answer 403 before requests reach Bun.serve.
if (!process.env.NO_PROXY || process.env.NO_PROXY.trim() === "") {
  process.env.NO_PROXY = "127.0.0.1,localhost";
}
if (!process.env.no_proxy || process.env.no_proxy.trim() === "") {
  process.env.no_proxy = process.env.NO_PROXY;
}

export {};
