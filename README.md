# Free-Flow Family Chart

This app now runs with a shared backend so everyone who opens the hosted URL sees the same family tree data.

## Run with Docker

1. Start Docker Desktop.
2. From this folder, run:

   ```powershell
   docker compose up --build -d
   ```

3. Open `http://localhost:8080`.

## Login and account access

- The app now requires login for all users.
- On first startup, the API creates a bootstrap admin account from `docker-compose.yml`:
   - Username: `admin`
   - Password: `change-me-123`
- Sign in with that admin account, then use the in-app **Admin Console** to create accounts for family members.
- Admin Console account actions:
   - Create account
   - Reset password
   - Disable/enable account
   - Delete account
- After first use, change `ADMIN_PASSWORD` in `docker-compose.yml` and restart:

   ```powershell
   docker compose up --build -d
   ```

## Login rate limiting

- Failed login attempts are rate-limited per client IP.
- Defaults (set in `docker-compose.yml`):
   - `LOGIN_WINDOW_MS=600000` (10 minutes)
   - `LOGIN_MAX_ATTEMPTS=8`
   - `LOGIN_BLOCK_MS=900000` (15 minutes)

## HTTPS and secure session cookies (Cloudflare)

- Session auth now uses `HttpOnly` cookie-based sessions (not localStorage tokens).
- Keep Cloudflare SSL/TLS mode at **Full (strict)**.
- Configure origin TLS certificate for your host and enforce HTTPS.
- Cookie security behavior is controlled with:
   - `COOKIE_SECURE_MODE=auto` (default): secure cookie when request is HTTPS.
   - Set `COOKIE_SECURE_MODE=always` for public internet deployments.
- `TRUST_PROXY=1` is enabled so secure detection works correctly behind reverse proxies.

## Stop the app

```powershell
docker compose down
```

## Update and restart

```powershell
docker compose up --build -d
```

## Share on your home network

1. Find your machine IPv4 address (for example `192.168.1.42`).
2. Ask family members on the same network to open:

   `http://<your-ip>:8080`

3. Allow Docker/Desktop firewall prompts when shown.

## Data persistence

- Shared data is stored in a Docker volume named `family-tree_family-tree-data`.
- Restarting containers keeps data.
- To remove everything including stored data:

  ```powershell
  docker compose down -v
  ```
