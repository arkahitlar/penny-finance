# Publish Penny: private GitHub + Vercel

The application is prepared for these services. A live deployment requires access to your accounts and the credentials below. Never commit `.env` or paste secret values into the repository.

## 1. Private GitHub repository

Create a private repository named `penny-finance` (or another available name), with no generated README or .gitignore, and push this project. If using GitHub CLI after signing in:

```sh
gh auth login
gh repo create penny-finance --private --source=. --remote=origin --push
```

GitHub stores the source. GitHub Pages cannot run this app's Node.js authentication, database, and AI endpoints; Vercel hosts those endpoints and the frontend together.

## 2. Turso database

Create a database and an auth token in your [Turso account](https://turso.tech/). Put the database URL and token into a local `.env` file copied from `.env.example`.

```sh
cp .env.example .env
# Set the real Turso URL/token in .env, then:
npm run db:migrate
```

This command creates the user/session, expense, draft, and parsing-quota tables. Run it again before deploying the payment-method update: existing expenses are preserved with payment method “Not specified”. It also safely upgrades the previous single-user schema. Existing shared expenses are preserved under an inaccessible legacy account; they are never assigned to the first person who signs in. A failed migration rolls back instead of committing partial changes. Use a backup of existing production data before running a schema migration there.

Use a **remote** `libsql://...` database on Vercel. `file:local.db` is only for local development.

## 3. Google sign-in credentials

In the [Google Cloud console](https://console.cloud.google.com/), use a project you own:

1. Configure the OAuth app's name, audience, and support contact for Penny. It requests only basic identity scopes: `openid`, `email`, and `profile`.
2. Create an OAuth client of type **Web application**. Keep the client secret on the server.
3. Add this local authorized redirect URI if you want to test sign-in locally:

   ```text
   http://localhost:3000/api/auth?action=callback
   ```

4. Once Vercel has assigned the production domain, add its exact callback URI as well:

   ```text
   https://YOUR-APP.vercel.app/api/auth?action=callback
   ```

5. Add test users while your Google OAuth app is in testing mode. When you are ready for other users, configure the appropriate production audience and complete any setup Google requests. Its public data information page is `https://YOUR-APP.vercel.app/privacy.html`.

The callback includes `?action=callback`; register that full string. `APP_URL` must match the browser's origin exactly. Use one canonical production domain. Arbitrary Vercel preview URLs do not automatically become authorized Google redirects; leave auth unconfigured on previews or explicitly configure a separate stable preview origin/client.

## 4. Vercel project

In [Vercel](https://vercel.com/new), import the private GitHub repository with access limited to that repository. Use:

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Node.js version | 22.x |
| Build command | `npm run build` |
| Output directory | `dist` |
| Install command | `npm ci` |

`vercel.json` already defines the build, output directory, function duration, and security headers. Serverless endpoints are in `api/`.

Add these server-side environment variables for the production deployment:

| Variable | Value |
| --- | --- |
| `APP_URL` | The exact production origin, e.g. `https://penny-finance.vercel.app` |
| `GOOGLE_CLIENT_ID` | Web application's Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `TURSO_DATABASE_URL` | Remote Turso database URL |
| `TURSO_AUTH_TOKEN` | Database auth token |
| `OPENAI_API_KEY` | Your server-side OpenAI API key |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4o-mini` |

The first deployment can establish the Vercel domain without credentials; it will show the sign-in setup state and a working sample journal. After setting `APP_URL`, registering the Google callback, and saving the credentials, redeploy so the functions receive them. A source deployment without credentials is not a verified live sign-in deployment.

Use separate databases/credentials for preview and production. If the live application should be available to all users, ensure your Vercel access settings allow them to reach it; the app itself requires Google sign-in for all personal data.

## 5. Verify the live app

1. Sign in with Google and enter `coffee for 80`. Confirm that the popup detects Food & drink and Save stays disabled until you choose Cash or Credit card. Save it.
2. Refresh and confirm the expense and payment method persist. Try another description, correct its category, then cancel; the total should stay unchanged.
3. Open Reports and inspect Daily, Weekly, and Monthly; download a CSV and confirm its payment-method column.
4. Sign out. The private journal should disappear, and API requests should return 401.
5. Sign in as a second account and confirm the first account's expenses are absent.

The automated suite covers these boundaries with mocked Google verification and temporary databases. Only this live account test verifies your actual Google client, callback registration, remote database, and provider key.

## References

- [Google: server-side OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect)
- [Vercel: GitHub integration](https://vercel.com/docs/git/vercel-for-github)
- [Vercel: environment variables](https://vercel.com/docs/environment-variables)
- [Turso: quickstart](https://docs.turso.tech/quickstart)
