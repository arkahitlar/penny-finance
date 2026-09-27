# Penny for Android — direct-install release

Penny 1.0.0 opens [penny-gsk.vercel.app](https://penny-gsk.vercel.app/) in a browser-backed **Trusted Web Activity (TWA)**. It uses the live website and its existing Google sign-in. It is not a WebView, and Google Play publishing is not included in this release.

| Setting | Value |
| --- | --- |
| Android package | `app.vercel.penny_gsk` |
| Version / version code | `1.0.0` / `1` |
| Minimum Android | Android 6.0, API 23 |
| Compile / target SDK | API 36 |
| Local release artifact | `output/android/Penny-1.0.0.apk` |
| Direct download | [penny-1.0.0.apk](https://penny-gsk.vercel.app/downloads/penny-1.0.0.apk) |

## Install on a phone

1. Open the download link on your Android phone and download the APK.
2. Open the downloaded APK from that browser or the Files app.
3. If Android asks, permit installation **only for the specific browser or Files app you are using**, then return to the installer.
4. Install and open **Penny**. Keep Google Play Protect enabled. Do not disable device-wide security protections to install the app.
5. Turn that source's “Install unknown apps” permission off again after installation.

An up-to-date Chrome browser is recommended. Internet access is required to sign in, read your journal, and save changes; the offline screen does not provide an offline expense database or queue saves. The APK requests no camera, contacts, or storage access.

The app uses the selected browser's profile and cookies. A Penny session already open in that browser may also be signed in inside the app, and signing out affects that shared session. A different browser/profile may require another sign-in. Google sign-in temporarily shows a browser toolbar; this is expected while you are on Google's website.

## Build from source

The repository contains the Bubblewrap configuration and generator. `generate.cjs` reads the checked-in web manifest and icons in `public/`, so project generation does not require those assets to have been deployed first. Generated Android code uses:

- Bubblewrap core **1.25.0**, pinned in `android/package.json` and its lockfile.
- Gradle **8.11.1**, Android Gradle Plugin **8.9.1**, and Android Browser Helper **2.6.2**.
- **JDK 21**, Android SDK platform **36**, and Build Tools **36.0.0**.

With Node.js and npm installed, run from the repository root:

```sh
npm ci --prefix android
npm run generate --prefix android
./android/build-apk.sh
```

Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to the SDK installation. To use signing files from a secure backup location, set `PENNY_SIGNING_KEY` and `PENNY_SIGNING_PASSWORD_FILE`; otherwise the script uses the local `.signing/` paths below. Generation recreates Android project files from `twa-manifest.json`; keep intended configuration changes in that manifest or the generator. The build script produces `output/android/Penny-1.0.0.apk` for this release.

The APK contains the browser launcher, app configuration, and public assets. It contains no private expense data, Google client secret, database token, or AI credentials. The website's server continues to handle authentication and private data. Do not copy a web `.env` file into Android assets or build resources.

## Preserve the signing identity

**Before deleting this worktree, back up both of these files securely:**

- `android/.signing/penny-release.keystore`
- `android/.signing/password.txt`

They are excluded from Git. Never upload either file to GitHub, the website, a public artifact, or an issue. Keep the backup encrypted and access restricted. The password and the keystore are both needed to sign future updates with the same identity. Losing the signing key prevents issuing a normal update over this directly installed app; generating a replacement key does not recover that identity.

The signing alias is `penny`. Its **public certificate fingerprint** is recorded in `android/twa-manifest.json` and the website's `public/.well-known/assetlinks.json`. Those values must match the certificate used to sign the installed APK and the exact package name above. The public fingerprint can be checked into Git; the private key and password cannot.

Publish `/.well-known/assetlinks.json` at the production origin before testing fullscreen verification. If the app shows a toolbar while on Penny itself, check the deployed asset links, package name, signing certificate, and selected browser. The Google toolbar during authentication is separate and expected.

For an update, preserve the package and signing key, increase `appVersionCode` and the displayed version in `twa-manifest.json`, regenerate, build, verify, and test installing over the previous version. Update artifact names and download links together. A future Play release needs its own publishing and signing review; it is outside this direct-install setup.

## Verification record

**153 web application tests pass**. The release APK builds successfully, its v1/v2/v3 signatures verify, and the certificate matches the checked-in Digital Asset Links. Browser testing confirmed offline fallback and recovery; device acceptance remains outstanding.

| Check | Recorded status |
| --- | --- |
| Web application automated tests | 153 passed |
| Release APK signature and expected certificate | Verified: v1, v2, v3; expected release certificate |
| Package, version, SDK levels, and permissions | Verified: Penny 1.0.0, app.vercel.penny_gsk, min 23 / target 36; no camera/contacts/location/storage permissions |
| Deployed asset links match release certificate | Pending production verification |
| Physical Android phone / Android emulator acceptance | **Not yet tested** |

Build success and desktop browser checks do not establish that Android installation or the full Google sign-in round trip works on a phone.

## Device acceptance checklist

- [ ] Install the signed APK and confirm the launcher name/icon, version, and expected package.
- [ ] Open Penny with current Chrome; confirm the production origin opens fullscreen after Digital Asset Links validation.
- [ ] Complete Google sign-in from a fresh browser profile; confirm the toolbar appears on Google and the callback returns to the private journal.
- [ ] Repeat with an existing browser session; cancel sign-in and try again; verify Back navigation is understandable.
- [ ] Add an expense, backdate it, edit its amount/date/payment/category, and delete the test entry. Confirm Today, Reports, filters, comparisons, and CSV stay consistent.
- [ ] Rotate the phone, use large system text, open the keyboard/date picker, and check that modal controls remain reachable.
- [ ] Background/resume the app, cross an India-time day boundary, and verify the visible date and account refresh correctly.
- [ ] Sign out, reopen, and confirm private data is cleared; verify an expired session returns to sign-in.
- [ ] Launch offline and interrupt a save's network connection. Confirm no private journal is cached for offline display and a retry cannot duplicate an expense.
- [ ] Test a browser without TWA support: browser/Custom Tab fallback should remain usable without weakening authentication.
- [ ] Install a newer build signed with the same key over this version and confirm the update succeeds.

Use a test account or clearly identified temporary entries and remove them after testing. Retain the final APK checksum and verification results with the release artifact.
