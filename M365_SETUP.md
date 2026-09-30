# Microsoft 365 sign-in for the Grid Portal — setup (for the Microsoft 365 / Entra admin)

Goal: staff sign in to **https://grid.idealinsurance.in** with their office Microsoft account. Only Ideal Insurance accounts are accepted.

## 1. Register the app (Microsoft Entra admin center, ~5 min)
1. Go to **entra.microsoft.com** → **Applications → App registrations → + New registration**
2. **Name:** `Grid Matrix Portal`
3. **Supported account types:** *Accounts in this organizational directory only (Single tenant)*
4. **Redirect URI:** platform **Web** → `https://grid.idealinsurance.in/api/auth/m365/callback`
5. Click **Register**. On the Overview page copy:
   * **Application (client) ID**
   * **Directory (tenant) ID**
6. **Certificates & secrets → + New client secret** → description `grid-portal`, expiry **24 months** → **Add** → copy the **Value** immediately (shown once).
7. **API permissions:** `Microsoft Graph → openid, profile, email` (User.Read is added by default — fine). Click **Grant admin consent** if shown.
8. *(Optional — restrict who can sign in)* **Enterprise applications → Grid Matrix Portal → Properties → Assignment required = Yes**, then **Users and groups → Add** the people / group allowed to use the portal.

Nothing about existing apps (e.g. the CRM's Microsoft sign-in) changes.

## 2. Put the 3 values on the server (never in chat / GitHub)
In the server Console:
```
cd /root/grid-portal && nano .env
```
Add these lines at the end (paste your values), save with **Ctrl+O, Enter, Ctrl+X**:
```
PUBLIC_URL=https://grid.idealinsurance.in
M365_TENANT_ID=<Directory (tenant) ID>
M365_CLIENT_ID=<Application (client) ID>
M365_CLIENT_SECRET=<client secret Value>
M365_ALLOWED_DOMAINS=idealinsurance.in
```
Then restart the portal: `cd /root/grid-portal/app && docker compose up -d`

## 3. How it behaves
* The sign-in page shows **Sign in with Microsoft**. First-time users are created automatically as **viewer**.
* Admins promote people (viewer → admin) or **Block** them at **grid.idealinsurance.in/admin**.
* Email + password sign-in is also on the same page, for users without Office 365. Admins create these accounts at /admin (temporary password → the user sets their own at first sign-in).
* The client secret expires after 24 months — create a new one before then and update `M365_CLIENT_SECRET`.
