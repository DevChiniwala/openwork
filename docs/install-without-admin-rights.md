# Installing OpenWork without administrator rights

## Short answer

**Self-install is a viable proof-of-concept path for current Electron builds, subject to the organization's endpoint policy.** Not having local administrator rights is different from being allowed to run downloaded software.

| OS / package | Can a standard user install it? | Conditions |
| --- | --- | --- |
| Windows, current Electron NSIS `.exe` | **Yes, expected without elevation.** | Default installation is per-user, normally under `%LOCALAPPDATA%\Programs`. Application-control policy must permit the installer, app, and its child executables. |
| macOS, current Electron `.dmg` / `.zip` | **Yes, into a user-writable folder.** | Copy the `.app` to `~/Applications` (create that folder if needed). Copying to shared `/Applications` depends on its permissions and may require administrator authorization. |
| Windows, historical Tauri `.msi` | **No for an ordinary self-install of the machine-wide package.** | Treat it as IT-managed/elevation-requiring; do not apply the current NSIS answer to old MSI releases. |

**Confidence and scope:** source/configuration review dated 2026-10-21 at commit `70d8203cfe7e38c3936b13d9a07040ca0a90e6e8`. No standard-user installation or update on a managed Windows/Mac device was performed for this investigation. This is not a certification of a particular downloaded release. Record the exact version, distribution, architecture, checksum, and signature before testing it. Public, Cloud, and Enterprise flavors inherit the same installer base.

## Windows evidence

### Current installer is per-user already

- [`apps/desktop/package.json`](../apps/desktop/package.json), `main` and `package:electron*`: the active desktop shell and packaging scripts are Electron, not Tauri.
- [`apps/desktop/electron-builder.base.yml`](../apps/desktop/electron-builder.base.yml), `win.target` and `nsis`: selects NSIS and `build/installer.nsh`. It does **not** override `oneClick`, `perMachine`, or `win.requestedExecutionLevel`.
- [`electron-builder.yml`](../apps/desktop/electron-builder.yml), [`electron-builder.cloud.yml`](../apps/desktop/electron-builder.cloud.yml), and [`electron-builder.enterprise.yml`](../apps/desktop/electron-builder.enterprise.yml) all extend that base without changing install scope.
- [`pnpm-lock.yaml`](../pnpm-lock.yaml), desktop importer and resolved dependencies: pins electron-builder/app-builder-lib **26.15.3** and electron-updater **6.8.3**. Their installed implementation was inspected, not just assumed from generic NSIS behavior.

The versioned dependency evidence is available in the published [app-builder-lib 26.15.3 package](https://unpkg.com/browse/app-builder-lib@26.15.3/):

| Dependency file / symbol | What it establishes |
| --- | --- |
| `out/targets/nsis/nsisOptions.d.ts`, `NsisOptions` | Defaults: `oneClick: true`, `perMachine: false`. `allowElevation` applies to assisted installers, not this default one-click mode. |
| `out/targets/nsis/NsisTarget.js`, `buildInstaller` / `configureDefines` | Sets one-click and machine-wide defines from those options. |
| `templates/nsis/installer.nsi`, `RequestExecutionLevel` | Requests `user` for this scope; requests `admin` for a machine-wide installer. |
| `templates/nsis/oneClick.nsh`, install-mode selection | Selects per-user installation for the current configuration. |
| `templates/nsis/multiUser.nsh`, `setInstallModePerUser` | Uses current-user shell context and HKCU installation registration. Resolves the user's Programs known folder, falling back to `$LocalAppData\Programs`, then appends the application folder. A previous HKCU location or `/D=` can override it. |
| `out/options/winOptions.d.ts`, `requestedExecutionLevel` | Application executable defaults to `asInvoker`; the repository does not override it to `requireAdministrator`. |

The normal destination is therefore the **user's** Programs folder, not machine-wide `Program Files`. Do not select a protected `/D=` location or run the installer as administrator for this proof of concept.

[`apps/desktop/build/installer.nsh`](../apps/desktop/build/installer.nsh) contains only an uninstall hook that removes a user branding shortcut/marker. There is no custom install-time service, driver, prerequisite, firewall-rule, or elevation action. The `afterPack`/`afterSign` hooks are **build-time** hooks, not customer post-install scripts. Native code, Electron, and OpenCode sidecars are packaged with the app; no Node/Bun/Rust development installation or WebView2 bootstrap is part of the current installer path.

### Updates are not an unconditional no-UAC guarantee

[`apps/desktop/electron/updater.mjs`](../apps/desktop/electron/updater.mjs), `registerUpdaterIpc`, uses electron-updater, stages downloads, and can install on quit or explicit restart. A normally writable per-user installation should update as that user.

The published [electron-updater 6.8.3 package](https://unpkg.com/browse/electron-updater@6.8.3/), `out/NsisUpdater.js`, `doInstall`, normally launches the installer directly. It can invoke `elevate.exe` when update metadata requires administrator rights or after `UNKNOWN` / `EACCES` launch errors. The builder packages the elevation helper by default even for per-user installs. Its presence does **not** mean first installation requires elevation, but it prevents promising that every update path will never show UAC. Protected previous locations, a legacy machine-wide installation, or endpoint blocks need separate handling by IT—not a suggestion to bypass policy.

### Historical Tauri packages differ

The historical [`v0.13.3` Tauri config](https://github.com/different-ai/openwork/blob/v0.13.3/apps/desktop/src-tauri/tauri.conf.json) did not select a Windows per-user mode. Its [release workflow](https://github.com/different-ai/openwork/blob/v0.13.3/.github/workflows/release-macos-aarch64.yml) explicitly passed `--bundles msi` on Windows.

The [Tauri 2.10.3 WiX template](https://github.com/tauri-apps/tauri/blob/tauri-v2.10.3/crates/tauri-bundler/src/bundle/windows/msi/main.wxs) declares `InstallScope="perMachine"` and conditionally installs WebView2. Tauri NSIS's separate `currentUser` default does not establish that an MSI is per-user. Confirm the actual artifact; migration/uninstallation of an old machine-wide build may need IT even when a fresh Electron installation does not.

## macOS evidence

- [`apps/desktop/electron-builder.base.yml`](../apps/desktop/electron-builder.base.yml), `mac.target`: builds **DMG and ZIP**, not a PKG. These deliver an app bundle to copy, rather than a privileged package with post-install scripts.
- The base config sets hardened runtime and entitlements. `notarize: false` there disables the builder's built-in notarizer; it does **not** mean releases are deliberately unnotarized. [`electron-after-sign.cjs`](../apps/desktop/scripts/electron-after-sign.cjs), `afterSign`, submits with `notarytool`, staples, and verifies the app when `MACOS_NOTARIZE=true`. The [release workflow](../.github/workflows/release-macos-aarch64.yml), “Reject unnotarized macOS Electron release” and “Package Electron (macOS, signed + notarized),” requires this path.
- [`apps/desktop/electron/main.mjs`](../apps/desktop/electron/main.mjs) contains no `moveToApplicationsFolder` / forced relocation flow. Its application discovery includes `~/Applications`. Normal startup does not require installation into `/Applications`.
- [`build/entitlements.mac.plist`](../apps/desktop/build/entitlements.mac.plist) declares runtime/audio/AppleEvents entitlements; it does not install a privileged helper, system extension, or driver. The Computer Use helper is bundled inside the app (`mac.extraResources`), not installed as a root service.

**User procedure:** obtain the approved signed/notarized release; mount the DMG or extract the ZIP; copy the complete `.app` into `~/Applications`; launch that copy and eject the DMG. Do not assume the DMG's shared Applications shortcut is the non-admin destination. Do not run from the read-only DMG as the permanent installation, disable Gatekeeper, or remove quarantine to work around organizational controls.

Gatekeeper/download confirmation is distinct from administrator elevation. MDM may still prohibit apps outside shared `/Applications` or require IT approval even for a valid Developer ID signature. Verify the exact downloaded artifact rather than inferring signature/notarization status solely from build configuration.

**Updates:** [`updater.mjs`](../apps/desktop/electron/updater.mjs), `enableSquirrelDirectContentsWrite` and `staleUpdaterStatePaths`, configures Squirrel.Mac to write application contents in place, with cache under the user's `~/Library/Caches`. A user-owned app should be writable; an IT-owned/protected app may need authorization or fail to update. Test first install and update separately.

## Runtime: ordinary user rights, with feature/policy caveats

### Writable state and workspace locations

These are the default paths without environment overrides (macOS also honors relevant XDG overrides):

| State | Windows | macOS | Repository evidence |
| --- | --- | --- | --- |
| Electron profile, logs, server tokens/state | `%APPDATA%\com.differentai.openwork` | `~/Library/Application Support/com.differentai.openwork` | [`main.mjs`](../apps/desktop/electron/main.mjs), profile setup; [`dev-profile.mjs`](../apps/desktop/electron/dev-profile.mjs), `resolveUserDataPath`; [`runtime.mjs`](../apps/desktop/electron/runtime.mjs), server state/log paths |
| Server config / default runtime DB | `%APPDATA%\openwork` | `~/.config/openwork` | [`packages/paths/index.mjs`](../packages/paths/index.mjs), `openworkServerConfigPath`; [`runtime-db.ts`](../apps/server/src/runtime-db.ts), DB path resolution |
| Desktop bootstrap | `%LOCALAPPDATA%\openwork\desktop-bootstrap.json` | `~/.config/openwork/desktop-bootstrap.json` | [`packages/paths/index.mjs`](../packages/paths/index.mjs), bootstrap resolution |
| Global OpenCode config | `~/.config/opencode` in the user's home | `~/.config/opencode` | [`packages/paths/index.mjs`](../packages/paths/index.mjs), OpenCode config resolution |
| Default new local workspace | `OpenWork Chat` under the user's home | `~/OpenWork Chat` | [`workspace-store.mjs`](../apps/desktop/electron/workspace-store.mjs), `bootstrapFirstLaunchWorkspace` and workspace creation |

Selected workspace folders also receive `.opencode` configuration and agent-created files. The user must be allowed to create/write/rename files there and in profile/config/cache/temp directories. Controlled Folder Access, redirected/read-only profiles, or restricted Documents/home folders can block this independently of admin rights. Overrides pointing to system locations can introduce permission requirements; `OPENWORK_ELECTRON_USERDATA` alone does not redirect all OpenWork/OpenCode state.

[`runtime.mjs`](../apps/desktop/electron/runtime.mjs) discovers packaged engines and launches the embedded OpenWork server. [`managed-opencode.ts`](../apps/server/src/managed-opencode.ts) and [`managed-opencode-v2.ts`](../apps/server/src/managed-opencode-v2.ts) launch ordinary engine child processes. No mandatory Windows Service, launch daemon, kernel driver, or privileged scheduler installation was found in this desktop path. Local automation runs in the desktop process ([`automation-runner.mjs`](../apps/desktop/electron/automation-runner.mjs)); it is not an always-on system service.

Optional/fallback engine installation in [`opencode-v2-binary.ts`](../apps/server/src/opencode-v2-binary.ts) downloads a pinned, integrity-checked binary into runtime storage and extracts it with `tar`. [`opencode-v2-artifacts.json`](../apps/server/src/opencode-v2-artifacts.json) currently points to `registry.npmjs.org`. This still needs permission to download and execute profile-resident binaries; it is not a request for administrator rights. Optional tools/integrations can have their own external prerequisites, not guaranteed by the desktop installer.

### Network, credentials, and privacy

| Area | Finding / what IT must allow |
| --- | --- |
| Local listeners | Desktop [`runtime.mjs`](../apps/desktop/electron/runtime.mjs) binds the embedded server to `127.0.0.1`, selecting an available port; managed engines and [`ui-control-server.mjs`](../apps/desktop/electron/ui-control-server.mjs) also use loopback/dynamic ports. No privileged fixed port or firewall-rule installation is required by this path. Loopback is not a guarantee against EDR/firewall blocks or prompts. A separate LAN/self-hosted server configuration needs its own review. |
| Outbound traffic | Allow the chosen control plane/authentication/inference and MCP destinations, plus release/update assets and any enabled runtime downloads over HTTPS. The exact list depends on distribution, organization URLs, model provider and integrations; do not use a blanket “allow all” rule. Proxy and TLS inspection must work for the app **and** engine subprocesses. |
| Corporate certificates | [`system-ca.mjs`](../apps/desktop/electron/system-ca.mjs) reads Windows CurrentUser/LocalMachine Root/CA stores or macOS system keychains; [`runtime.mjs`](../apps/desktop/electron/runtime.mjs) exports a PEM into userData. It does not install system trust roots. IT must provision necessary roots separately; certificate-store enumeration can itself be policy-blocked. |
| Credential protection | [`secure-vault-key.mjs`](../apps/desktop/electron/secure-vault-key.mjs) uses Electron `safeStorage` lazily for managed OAuth vault keys. Usable OS credential storage is needed; macOS keychain access may prompt the user, not require a system-keychain installation. This is not a claim that all app settings/tokens are encrypted by this vault. |
| Basic chat / file work | Does not require macOS Accessibility or Screen Recording simply to install/use the basic flow. File access is still limited by the user's rights, macOS privacy controls, and endpoint policy. |
| Local Computer Use | [`computer-local.mjs`](../apps/desktop/electron/computer-local.mjs) requires macOS 14+, Accessibility and Screen Recording consent. Granting these can require authentication/IT approval or be restricted by MDM. They are **not** bypassed by a non-admin install. This native local-control path is not supported on Windows. |
| App scripting / microphone | [`computer-scripting.mjs`](../apps/desktop/electron/computer-scripting.mjs) uses macOS `osascript`, with per-target Automation consent. Audio/dictation requires OS microphone/voice-typing permission. These are optional feature permissions, not install prerequisites. |
| Windows child processes | Terminal, shortcut repair, CA export, and dictation paths use native executables, PowerShell/COM or PTYs (see [`main.mjs`](../apps/desktop/electron/main.mjs), [`windows-shortcut.mjs`](../apps/desktop/electron/windows-shortcut.mjs), [`system-ca.mjs`](../apps/desktop/electron/system-ca.mjs), [`native-dictation.mjs`](../apps/desktop/electron/native-dictation.mjs)). AppLocker/WDAC/Defender and PowerShell restrictions may block features. Scope approvals to the pilot; do not disable protections or run the whole app elevated as a workaround. |

## Recommendations and acceptance checklist

1. **Start with fresh, current Electron per-user installs.** Windows: normal NSIS `.exe` launch as the standard user. macOS: user-owned `~/Applications` copy. Ask IT to approve the exact signed package/publisher, app/helper/engine binaries and native modules, profile execution locations, writable state/workspace paths, loopback communication, and required HTTPS destinations. A per-user install does not make the software trusted under enterprise policy.
2. **No installer config change is necessary to enable this path.** Current defaults already select per-user Windows installation, and macOS already ships copyable app bundles. For future hardening, explicitly pinning `nsis.oneClick: true` and `nsis.perMachine: false` would document the existing intent; it is not an enablement fix. `allowElevation: false` alone would not remove electron-updater's separate fallback. This PR deliberately changes documentation only, not packaging/update behavior.
3. **Keep the first pilot narrow:** basic sign-in, chat, and work on an approved writable folder. Add local Computer Use, scripting, dictation, extra tools and integrations only after their policy/privacy requirements are approved. If user-profile execution is forbidden, use an IT-managed deployment rather than trying to evade it. Machine-wide/bootstrap ACL enforcement and certificate distribution are separate IT-managed steps; see [desktop policies](desktop-app-policies.md) for app policy scope.
4. **Validate on real standard-user accounts before promising support.** Existing [`evals/packages/hosts/src/windows-release.ts`](../evals/packages/hosts/src/windows-release.ts), install/launch stages, explicitly uses the signed-in **Administrator** account; it is not non-admin evidence. A browser-only UI test cannot prove installer elevation behavior either.

For each approved Windows architecture/distribution and macOS architecture/distribution, record:

- [ ] OS/version, actual non-admin account status, package version/checksum and signature/notarization verdict.
- [ ] Clean install without administrator credentials/UAC elevation; destination, owner/ACLs and user registration/shortcuts. On Mac, verify the running bundle is the `~/Applications` copy, not the DMG copy.
- [ ] First launch, sign-in/browser callback, workspace creation, file write/read, engine startup and one model request with corporate proxy/security controls active.
- [ ] Credential storage access, restart and persisted state, without writes to protected system locations.
- [ ] Download/stage/apply a real update (explicit restart and install-on-quit paths), then verify the new on-disk version without elevation.
- [ ] Uninstall/app removal as the same user; document which user data remains. Test legacy MSI migration separately with IT.
- [ ] Optional features only if included in the pilot; record any privacy prompts, denied operations, application-control or firewall events and the exact IT approval needed.

**Suggested external wording:** “Current OpenWork Electron builds are designed for non-admin installation: per-user on Windows, and into a user-owned Applications folder on Mac. Your endpoint policies still need to permit the app and its runtime, and protected install locations or optional privacy-controlled features may need IT approval. We recommend a standard-user install-and-update check on your managed image before the pilot.”
