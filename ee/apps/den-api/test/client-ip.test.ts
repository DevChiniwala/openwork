import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULT_CLIENT_IP_HEADERS,
  normalizeClientIp,
  RESOLVED_CLIENT_IP_HEADER,
  resolveClientIp,
  withResolvedClientIp,
  type ClientIpOptions,
} from "../src/client-ip.js"

const defaults: ClientIpOptions = { headers: DEFAULT_CLIENT_IP_HEADERS, trustedProxies: [] }

function headers(values: Record<string, string>) {
  return new Headers(values)
}

test("a single x-forwarded-for entry is the client", () => {
  assert.deepEqual(resolveClientIp(headers({ "x-forwarded-for": "198.51.100.7" }), defaults), { ip: "198.51.100.7", source: "header", header: "x-forwarded-for" })
})

test("a multi-entry x-forwarded-for is not trusted without trusted proxies; the next header is used", () => {
  const request = headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.250", "x-real-ip": "198.51.100.7" })
  assert.deepEqual(resolveClientIp(request, defaults), { ip: "198.51.100.7", source: "header", header: "x-real-ip" })
})

test("with trusted proxies, the right-most untrusted x-forwarded-for hop is the client", () => {
  const options = { ...defaults, trustedProxies: ["10.0.0.0/8", "2001:db8::/32"] }
  const chain = headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7, 10.1.2.3, 2001:db8::1" })
  assert.equal(resolveClientIp(chain, options).ip, "198.51.100.7")
  assert.equal(resolveClientIp(headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }), options).ip, null)
})

test("no usable header means no address, never a guess", () => {
  assert.deepEqual(resolveClientIp(headers({ "x-real-ip": "unknown" }), defaults), { ip: null, source: "none", header: null })
  assert.equal(resolveClientIp(headers({ [RESOLVED_CLIENT_IP_HEADER]: "1.2.3.4" }), { ...defaults, headers: [RESOLVED_CLIENT_IP_HEADER] }).ip, null)
})

test("addresses are normalized: IPv6 to its /64, mapped IPv4 unwrapped, garbage rejected", () => {
  assert.equal(normalizeClientIp("2001:DB8:1:2:3:4:5:6"), "2001:0db8:0001:0002:0000:0000:0000:0000")
  assert.equal(normalizeClientIp("2001:db8:1:2::9"), "2001:0db8:0001:0002:0000:0000:0000:0000")
  assert.equal(normalizeClientIp("::ffff:198.51.100.7"), "198.51.100.7")
  assert.equal(normalizeClientIp("unknown"), null)
  assert.equal(normalizeClientIp("198.51.100.7:443"), null)
})

test("Better Auth receives only the resolved address, never a caller-supplied one", async () => {
  const request = new Request("https://den.example/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", [RESOLVED_CLIENT_IP_HEADER]: "1.2.3.4", "x-real-ip": "198.51.100.7" },
    body: JSON.stringify({ email: "a@example.com" }),
  })
  const rewritten = withResolvedClientIp(request, resolveClientIp(request.headers, defaults))
  assert.equal(rewritten.headers.get(RESOLVED_CLIENT_IP_HEADER), "198.51.100.7")
  assert.deepEqual(await rewritten.json(), { email: "a@example.com" })

  const spoofed = new Request("https://den.example/api/auth/get-session", { headers: { [RESOLVED_CLIENT_IP_HEADER]: "1.2.3.4" } })
  const unresolved = withResolvedClientIp(spoofed, { ip: null, source: "none", header: null })
  assert.equal(unresolved.headers.get(RESOLVED_CLIENT_IP_HEADER), null)
})
