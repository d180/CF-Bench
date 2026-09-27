# Setup

CF-Bench operates a real Cloudflare zone and a real origin server. Nothing is mocked, so
the environment has to exist before any task will run.

Budget roughly an hour. Everything here fits in free tiers except the domain.

> **Use a throwaway Cloudflare account holding nothing else.** Tasks genuinely break the
> zone, and an agent given dashboard access can change anything in that account. One of
> the required token permissions is account-wide and cannot be narrowed.

---

## 1. Cloudflare account and domain

Create a **new** Cloudflare account, then add a domain you do not care about and point its
nameservers at Cloudflare. Wait for the zone to read **Active**.

From the zone's Overview page, take the **Zone ID** and **Account ID**.

Delete any records the scan imported that you do not need. Underscore records such as
`_dmarc` are often imported proxied, which is wrong; set those to DNS-only or remove them.

---

## 2. Origin server

Any machine with a public IP where you control nginx. A GCP `e2-micro` in `us-west1`,
`us-central1` or `us-east1` is free tier; Ubuntu 24.04.

**Reserve the external IP as static.** DNS records point at it, and an ephemeral address
changes on restart — which task 06's setup requires later.

Open ports 80 and 443.

### A second address, for task 06

Task 06 needs an old deployment still answering alongside the new one. Because Cloudflare
sends the same `Host` header to both, the *address* is the only thing distinguishing them,
so the origin needs two.

On GCP, IPv6 is free where a second IPv4 is not. IPv6 subnets require a custom-mode VPC:

```bash
gcloud compute networks update default --switch-to-custom-subnet-mode   # one-way
gcloud compute networks subnets update default \
  --region=us-central1 --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL

gcloud compute instances stop cf-bench-origin --zone=us-central1-a
gcloud compute instances network-interfaces update cf-bench-origin \
  --zone=us-central1-a --network-interface=nic0 --stack-type=IPV4_IPV6
gcloud compute instances start cf-bench-origin --zone=us-central1-a

# the IPv4-only firewall rules do not cover this, and its absence is silent
gcloud compute firewall-rules create allow-http-https-ipv6 \
  --network=default --direction=INGRESS --action=ALLOW \
  --rules=tcp:80,tcp:443 --source-ranges=::/0 \
  --target-tags=http-server,https-server

gcloud compute instances describe cf-bench-origin --zone=us-central1-a \
  --format='get(networkInterfaces[0].ipv6AccessConfigs[0].externalIpv6)'
```

The address is under `ipv6AccessConfigs[0].externalIpv6`. The `ipv6Address` field is the
internal one and will read empty.

Tasks 01–05 work without this; only task 06 requires it.

---

## 3. Origin certificate

Task 01 requires Full (strict), which means Cloudflare validates the certificate the
origin presents for the **proxied** hostname. Getting Let's Encrypt to issue for a
hostname already behind the proxy means ACME-through-the-proxy or DNS-01 plumbing.

Cloudflare **Origin CA** avoids all of it: **SSL/TLS → Origin Server → Create Certificate**,
defaults are correct, 15-year validity. The private key is shown once.

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo tee /etc/ssl/cloudflare/origin.pem >/dev/null <<'EOF'
-----BEGIN CERTIFICATE-----
...
EOF
sudo tee /etc/ssl/cloudflare/origin.key >/dev/null <<'EOF'
-----BEGIN PRIVATE KEY-----
...
EOF
sudo chmod 600 /etc/ssl/cloudflare/origin.key
```

Origin CA certificates are trusted by Cloudflare, not by browsers. That is correct — they
secure the Cloudflare-to-origin leg only, which is exactly what the ticket asks for.

---

## 4. nginx

Copy [`origin/cf-bench.nginx`](./origin/cf-bench.nginx) to
`/etc/nginx/sites-available/cf-bench`, replacing the hostnames and the IPv6 address with
your own.

```bash
sudo ln -sf /etc/nginx/sites-available/cf-bench /etc/nginx/sites-enabled/cf-bench
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

What the graders depend on, so do not simplify it away:

| | |
| --- | --- |
| Port 80 redirects to HTTPS | the origin half of task 01's redirect loop |
| `X-CFBench-Site` / `X-CFBench-Origin` headers | proves a response came from the origin, and from *which* one |
| `/api/time` changes every request, sends `no-store` | makes "stale" unambiguous rather than a judgement call |
| `/admin` returns 200 normally | so an edge block (403) is distinguishable from a 404 |

The config omits `http2 on` deliberately — Ubuntu 24.04 ships nginx 1.24 and that
directive arrived in 1.25.1. Cloudflare speaks HTTP/1.1 to origins regardless.

Verify before DNS exists, forcing the Host header:

```bash
curl -sk -o /dev/null -D- -H "Host: www.example.com" https://YOUR_IP/   # 200 + marker
curl -sk -H "Host: www.example.com" https://YOUR_IP/api/time            # twice; must differ
curl -s  -o /dev/null -D- -H "Host: www.example.com" http://YOUR_IP/     # 301 to https
```

`-k` is expected: the Origin CA certificate is not trusted by curl, only by Cloudflare.

---

## 5. DNS

Four proxied `A` records pointing at the origin: apex, `www`, `staging`, `api`.

Then **SSL/TLS → Overview → Custom SSL/TLS → Full (strict)**.

That last step matters more than it looks. New zones may be on **Automatic SSL/TLS**,
which rescans the origin — more often after configuration changes, which is exactly what
seeding is — and can silently move the mode. Left on automatic, Cloudflare will
occasionally repair a deliberately broken task behind the benchmark's back. Tasks pin
`ssl_automatic_mode` to `custom` when they seed for this reason.

---

## 6. API token

**My Profile → API Tokens → Create Custom Token.** Seven permissions:

| Scope | Permission | For |
| --- | --- | --- |
| Zone | Zone Settings — Edit | SSL mode |
| Zone | SSL and Certificates — Edit | certificate state |
| Zone | DNS — Edit | records |
| Zone | Zone WAF — Edit | custom rules |
| Zone | Cache Rules — Edit | cache rules |
| Zone | Zone — Read | resolve the zone |
| Account | Access: Apps and Policies — Edit | task 02 |

Scope **Zone Resources** to the one zone. Edit implies read, so no separate read rows are
needed.

*Access: Apps and Policies* is unavoidably account-wide — it cannot be narrowed to a zone.
That is the strongest argument for the throwaway account.

Reading the Access **organization** needs an eighth permission, deliberately not granted:
the grader asserts the redirect lands on a team domain held in config, so the extra
account-wide permission would buy one string already known.

---

## 7. Zero Trust

Left nav → **Zero Trust**. Choose a team name — it becomes
`<team>.cloudflareaccess.com`, which task 02's grader asserts against — and the **Free**
plan.

Set the team name before creating any Access application. Renaming later invalidates
stored run history and the grader's expected redirect target.

Cloudflare asks for a payment method during Zero Trust onboarding even on Free. The
built-in one-time PIN provider is all task 02 needs; no external IdP.

---

## 8. Configuration

```bash
cp .env.example .env
```

| Key | Notes |
| --- | --- |
| `CF_API_TOKEN` | from step 6 |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_ZONE_NAME` | from step 1 |
| `CF_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` |
| `ACCESS_ALLOWED_EMAIL_DOMAIN` | the domain task 02 admits |
| `ORIGIN_A_IP` | the origin's IPv4 |
| `ORIGIN_B_ADDR` | the second address; task 06 only |
| `ADMIN_ALLOWED_IP` | must be neither the grader's address (or the block is unobservable) nor the origin (or the ticket contradicts itself) — a documentation address such as `203.0.113.40` is ideal |

`.env` is gitignored. `worker/.dev.vars` mirrors it for local Worker development; production
uses `wrangler secret put`.

Verify the token before building on it:

```bash
npm run cf-bench -- grade 01-ssl-redirect-loop
```

---

## 9. Worker and dashboard

```bash
cd worker && npx wrangler d1 execute cf-bench --local --file=./migrations/0001_init.sql
npx wrangler d1 execute cf-bench --local --file=./migrations/0002_agent_kind.sql
npx wrangler d1 execute cf-bench --local --file=./migrations/0003_model.sql
```

Local D1 is a SQLite file Wrangler creates itself. No `wrangler login`, no remote database.

```bash
npm run worker:dev    # :8788
npm run web:dev       # :5173
```

The CLI never needs either — it talks to Cloudflare directly. The Worker only records runs
so the dashboard can show them, which is why the agent-run command carries on and says so
when the Worker is down.

---

## 10. browser-use agent

```bash
cd agents/browser-use
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

Set `OPENROUTER_API_KEY` and `BROWSER_USE_MODEL` in `.env`, then **sign in to the
Cloudflare dashboard in your normal Chrome.** The runner copies that profile, so the agent
inherits the session and never meets a login page.

That is not a convenience. The dashboard sits behind Cloudflare's own bot protection and
emails a verification code on an unrecognised device; no agent gets past either, and
Coasty's documentation is explicit that they do not solve CAPTCHAs. Having a person sign in
once removes the obstacle rather than automating around it.

```bash
npm run cf-bench -- agent-run 01-ssl-redirect-loop --agent browser-use
```

Close other Chrome windows first — the agent drives a copy of your profile.

### Model choice

`anthropic/*` models do not currently work with browser-use, in both directions:

- with `response_format` on, Claude compiles a grammar from browser-use's action-union
  schema and rejects it — *"The compiled grammar is too large"* — identically via
  Anthropic, Azure, AWS and Google, so a model limit rather than a flaky provider
- with browser-use's escape hatch on, no `response_format` is sent and Claude prefixes its
  JSON with markdown commentary, which `model_validate_json` rejects at line 1 column 1

Neither is fixable from here. `openai/gpt-5.1` is the default. Raise
`BROWSER_USE_MAX_TOKENS` above browser-use's 4096 default for any reasoning model — it
spends the budget on hidden reasoning before finishing the action object.

---

## Teardown

Delete the Cloudflare zone and the account, the VM, **and the reserved static IP**
separately — an unattached reserved IP bills at a higher rate than an attached one.
