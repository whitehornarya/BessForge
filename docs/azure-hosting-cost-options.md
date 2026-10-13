# Prototype hosting on Azure — shared platform + cost per new app

Rough **US pay-as-you-go** monthly estimates. Confirm live prices in the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) for your region.

## Chosen prototyping plan

| Layer | Choice | Why |
|-------|--------|-----|
| **PostgreSQL** | **One shared Flexible Server, 2 vCores** (e.g. Burstable **B2s**) | Hosts small DBs for **all** prototype apps; pay once, not per app |
| **App Service** | **One shared B1 plan** | Enough for thin Node APIs / static+API prototypes; multiple apps can sit on the same plan |
| **Frontend (optional)** | Static Web Apps **Free** per app, or static files from the B1 app | Layout/heavy UI work stays in the browser where applicable |
| **Auth** | **Entra ID Free** workforce SSO (Easy Auth) | Typically **$0** extra per app on the same tenant |
| **When an app goes company-wide** | Move that app to its **own B2** (or higher) plan | Isolation and headroom; leave other prototypes on shared B1 |

Does **not** include Cesium Ion (or similar) vendor fees or heavy tile egress spikes.

## Platform cost (paid once for all prototypes)

| Resource | Ballpark / month |
|----------|------------------|
| Postgres Flexible Server **2 vCores** (B2s-class) + modest storage | **~$25–45** |
| App Service plan **B1** (shared by prototype apps) | **~$13–20** |
| **Total shared platform** | **~$40–65** |

## Cost of each new prototype app

Assuming the shared **2 vCore Postgres** and **B1** plan already exist:

| Item for the new app | Incremental cost / month |
|----------------------|--------------------------|
| New Postgres **database** on the shared server | **~$0** (object) + storage (**often ~$0–5** if the DB stays small) |
| New Web App / API on the **same B1 plan** | **~$0** (plan already paid; more apps share capacity) |
| Static Web Apps Free (if used) | **~$0** |
| Entra Free SSO | **~$0** |
| **Typical total to add one prototype** | **~$0–5** |

Main limit is capacity on the shared B1 / Postgres — not a per-app fee. If many busy prototypes starve each other, either trim load or upsell the shared plan (still cheaper than a B2 each).

## Example: 1 vs 5 vs 10 prototypes

| Scenario | Shared platform | Incremental DBs | Ballpark total / month |
|----------|-----------------|-----------------|------------------------|
| Platform only (0 apps) | ~$40–65 | — | **~$40–65** |
| **+ 1 app** | ~$40–65 | ~$0–5 | **~$40–70** |
| **+ 5 apps** | ~$40–65 | ~$0–25 | **~$40–90** |
| **+ 10 apps** | ~$40–65 | ~$0–50 | **~$40–115** |

(Assumes small DBs and light API traffic on one B1.)

## When an app graduates (company-wide)

| Move | Ballpark add-on / month |
|------|-------------------------|
| Dedicated App Service **B2** for that app (leave prototypes on B1) | **~$25–40** for that app’s plan |
| Keep using shared Postgres (separate DB) **or** later split DB if needed | Usually still **~$0–5** incremental on shared Postgres until load requires a bigger server |

## Practical takeaway

- **Prototypes:** shared **2 vCore Postgres** + shared **B1** ≈ **$40–65 / month** for the platform.
- **Each new prototype app:** usually **~$0–5 / month** (mostly DB storage), not another server or App Service plan.
- **Company-wide app:** give it a **dedicated B2** (~**$25–40 / month** extra for that app); keep the prototype pool on B1.
