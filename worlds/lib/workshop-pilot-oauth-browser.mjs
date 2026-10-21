// Pass this self-contained function through the supported CDP browser-evaluation seam.
// Run ONLY in a workshop-origin tab in an existing Daytona browser, AFTER real consent.
// Does not read cookies, OAuth codes, localStorage or access tokens. No network off-origin.
export async function browserProbe(action = "snapshot", marker = "workshop-pilot-private") {
  if (!["snapshot", "mark", "find"].includes(action) || !/^workshop-pilot-[a-z0-9-]{1,64}$/.test(marker)) throw new Error("Invalid pilot operation/marker");
  const health = await fetch("/health").then((response) => response.json());
  if (location.protocol !== "https:" || health.service !== "open-workplace-workshop" || health.joinMode !== "automatic") throw new Error("Use an existing HTTPS automatic workshop tab");
  const json = async (path, method = "GET", body) => {
    const response = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Workshop ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const identity = await json("/v1.0/me");
  if (action === "find") {
    const files = await json("/v1.0/me/drive/root/children");
    return { guest: identity.displayName, markerPresent: files.value.some((file) => file.name === `${marker}.txt`) };
  }
  if (action === "mark") {
    await json("/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: [marker] });
    await json("/v1.0/me/events", "POST", { subject: marker, start: { dateTime: "2026-10-21T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-21T10:00:00", timeZone: "UTC" } });
    const file = await json(`/v1.0/me/drive/root:/${marker}.txt:/content`, "PUT", marker);
    const state = await json("/_workshop/state/atlassian");
    const issue = Object.values(state.jira.issues)[0];
    await json(`/jira/rest/api/2/issue/${issue.key}`, "PUT", { fields: { summary: marker } });
    const pages = await json("/confluence/rest/api/content?expand=version,body.storage");
    const page = pages.results[0];
    await json(`/confluence/rest/api/content/${page.id}`, "PUT", { id: page.id, type: "page", title: marker, version: { number: page.version.number + 1 }, body: { storage: { value: `<p>${marker}</p>`, representation: "storage" } } });
    return { guest: identity.displayName, fileId: file.id, changed: ["outlook", "calendar", "drive", "jira", "confluence"] };
  }
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  };
  const hashes = {};
  for (const service of ["microsoft", "atlassian"]) {
    const state = await json(`/_workshop/state/${service}`);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(stable(state))));
    hashes[service] = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Fictional identity and state digests only: never retain full business snapshots.
  return { guest: identity.displayName, mail: identity.mail, hashes };
}
