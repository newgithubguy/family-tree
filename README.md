# Free-Flow Family Chart

This app now runs with a shared backend so everyone who opens the hosted URL sees the same family tree data.

## Run with Docker

1. Start Docker Desktop.
2. From this folder, run:

   ```powershell
   docker compose up --build -d
   ```

3. Open `http://localhost:8080`.

## Deployment

Use the local compose file for development on your machine, and the Dockhand compose file for hosted deployment.

### Local development

- `docker-compose.yml` builds images from local folders.
- Use it only on a machine that has this full repository checked out.

### Hosted deployment with Dockhand

- `docker-compose.dockhand.yml` is the hosted deployment file.
- It pulls prebuilt images from GitHub Container Registry (GHCR).
- Use this file in Dockhand instead of `docker-compose.yml`.

### Step 1: Publish images to GHCR

1. Push this repository to GitHub.
2. Open the **Actions** tab in GitHub.
3. Run the **Publish Docker Images** workflow, or push a new commit to `main`.
4. Wait for the workflow to finish successfully.
5. Confirm these images exist in GitHub Packages:
   - `ghcr.io/newgithubguy/family-tree-web:latest`
   - `ghcr.io/newgithubguy/family-tree-api:latest`
6. If Dockhand cannot pull the images, open each package in GitHub and make it public.

### Step 2: Deploy in Dockhand

1. Open `docker-compose.dockhand.yml`.
2. Copy its contents into Dockhand.
3. Before deploying, change:
   - `ADMIN_PASSWORD` to a strong password
4. Deploy the stack.

### Step 3: Put Cloudflare in front

1. Point your domain or subdomain at the Dockhand-hosted app.
2. In Cloudflare SSL/TLS settings, use **Full (strict)**.
3. Enable HTTPS redirection.
4. Keep `TRUST_PROXY=1`.
5. For any public internet deployment, keep:
   - `COOKIE_SECURE_MODE=always`

### Deployment notes

- The hosted compose file is intentionally separate so remote platforms do not need access to local build context.
- User and chart data are stored in the `family-tree-data` volume.
- Re-deploying containers keeps existing data as long as the volume is preserved.

## Login and account access

- The app requires login for all users.
- On first startup, the API creates a bootstrap admin account from the compose environment:
   - Username: `admin`
   - Password: `change-me-123`
- Sign in with that admin account, then use the in-app **Admin Console** to create and manage accounts.
- Admin Console account actions:
   - Create account
   - Reset password
   - Disable/enable account
   - Delete account
- After first use, change `ADMIN_PASSWORD` in your active deployment compose file and restart:

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

## Files used for deployment

- `docker-compose.yml`: local development and local Docker builds
- `docker-compose.dockhand.yml`: hosted deployment through Dockhand
- `.github/workflows/publish-images.yml`: builds and publishes the web and API images to GHCR

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
