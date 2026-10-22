#!/usr/bin/env node
// Smoke-check the real HTML and markdown responses from a running landing site.
// Usage: pnpm check:shadow-ai --base-url http://localhost:3017
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const index = args.indexOf("--base-url");
const baseUrl = index >= 0 ? args[index + 1] : process.env.LANDING_BASE_URL;
if (!baseUrl) {
  console.error("Usage: pnpm check:shadow-ai --base-url http://localhost:<port>");
  process.exit(2);
}

async function read(path, accept = "text/html") {
  const response = await fetch(new URL(path, baseUrl), {
    headers: { Accept: accept },
    signal: AbortSignal.timeout(30000)
  });
  assert.equal(response.status, 200, `${path} must return 200`);
  return { response, body: await response.text() };
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

const { body: html } = await read("/shadow-ai");
const metas = [...html.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => tag);
const meta = (key) => metas.find((tag) => attribute(tag, "name") === key || attribute(tag, "property") === key);
assert.match(html, /<title>Shadow AI governance.*OpenWork<\/title>/);
assert.equal([...html.matchAll(/<h1\b/g)].length, 1, "exactly one H1");
assert.ok([...html.matchAll(/<h2\b/g)].length >= 5, "section headings are present");
for (const key of ["description", "og:title", "og:description", "og:image", "twitter:title", "twitter:description", "twitter:image"]) {
  assert.ok(attribute(meta(key) ?? "", "content"), `${key} is nonempty`);
}
assert.equal(attribute(meta("og:url"), "content"), "https://openworklabs.com/shadow-ai");
assert.equal(attribute(meta("twitter:card"), "content"), "summary_large_image");
const canonical = [...html.matchAll(/<link\b[^>]*>/g)].find(([tag]) => attribute(tag, "rel") === "canonical")?.[0];
assert.equal(attribute(canonical ?? "", "href"), "https://openworklabs.com/shadow-ai");

const schemas = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
  .map(([, json]) => JSON.parse(json));
const faq = schemas.find((schema) => schema["@type"] === "FAQPage");
assert.ok(faq, "FAQPage structured data is present");
assert.equal(faq.mainEntity.length, 6);
const visibleQuestions = [...html.matchAll(/<summary\b[^>]*>(.*?)<\/summary>/gs)]
  .map(([, summary]) => summary.replace(/<span\b[^>]*>.*?<\/span>/gs, "").trim());
const decode = (text) => text.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
assert.deepEqual(visibleQuestions.map(decode), faq.mainEntity.map((question) => question.name));
const visibleAnswers = [...html.matchAll(/<details\b[^>]*>.*?<p\b[^>]*>(.*?)<\/p>.*?<\/details>/gs)]
  .map(([, answer]) => decode(answer));
assert.deepEqual(visibleAnswers, faq.mainEntity.map((question) => question.acceptedAnswer.text));
console.log("PASS: title, metadata, canonical, headings, and visible FAQ/JSON-LD parity");

for (const path of ["/", "/enterprise"]) {
  const { body } = await read(path);
  assert.match(body, /href="\/shadow-ai"/, `${path} links to the new page`);
}
const { body: enterprise } = await read("/enterprise");
assert.match(enterprise, /Learn how to manage shadow AI/);
const { body: sitemap } = await read("/sitemap.xml", "application/xml");
assert.match(sitemap, /<loc>https:\/\/openworklabs.com\/shadow-ai<\/loc>/);
for (const path of ["/enterprise", "/pricing", "/privacy", "/connect", "/guides/claude-code-codex-cursor"]) {
  assert.ok(html.includes(`href="${path}"`), `outbound internal link to ${path}`);
  await read(path);
}
assert.match(enterprise, /id="book"/, "rollout CTA has a real booking anchor");
console.log("PASS: incoming links, outgoing destinations, booking anchor, and sitemap");

const { response, body: markdown } = await read("/shadow-ai", "text/markdown");
assert.match(response.headers.get("content-type"), /text\/markdown/);
assert.match(response.headers.get("vary"), /Accept/);
assert.match(markdown, /^# Manage shadow AI/);
assert.match(markdown, /AWS Bedrock/);
assert.match(markdown, /Workspace processing sends SSO configuration and model traffic/);
assert.match(markdown, /Product analytics, diagnostics, update checks/);
assert.match(markdown, /does not automatically discover or block/);
console.log("PASS: crawler markdown and governance/data-boundary copy");
