# 🍣 Kaiten Sushi Multiplayer: Architecture & Implementation Blueprint (v11)

> **Changes from v10:**
> - **Armed-toggle decision resolved:** a `−` while the round toggle is armed now **consumes (disarms)** the toggle and removes from only the clicked box, matching the add case where any tap is one-shot. Prevents an accidental round from a lingering armed toggle. Implemented in **`sushi-split-v4.html`**; offline-build references bumped v3 → v4. No open builder decisions remain.
>
> **From v9:**
> - **Activity-flash committed** (⭐). It carried an "Adopt as-is" verdict in review but had been left labeled optional — corrected. All eight review items are now reflected at their intended status.
>
> **From v8:**
> - **Security hardening committed (no login, no passcode).** RLS on; `anon` gets `SELECT` (for Realtime) + `EXECUTE` on RPCs only, no direct table writes. *All* mutations now go through a `security definer` **write surface** (§II) — `join_room`, `create_bill`, `add/rename/remove/claim_diner`, `add/update_menu_item`, `update_settings`, `tap`, `tap_everyone`, `close_bill`. Join is via `join_room(room_code)`; the `bill_id` UUID is never typed.
> - **Presence committed** (⭐) — tracks who's connected and, crucially, surfaces **who hasn't joined yet** so the table can nag them; three tile states (present / away / not-joined) + a "not joined" count. `claim_diner` now records `claimed_by_device` server-side to power this.
>
> **From v7/v8:**
> - **Apply-to-all is now ADD-ONLY.** A remove (`−`) always affects just the box it was clicked on, never the whole table. While the toggle is armed, a `−` does a normal single-box removal, **keeps the toggle armed** (so the intended round can still follow), and shows the `toastRemoveOne` toast ("Remove one at a time" / "減就一個一個嚟"). Rationale: bulk-removing everyone is rarely intended and easy to trigger by accident.
>
> **From v6** — reconciled with the offline build:
> - **Apply-to-all / round toggle** built (`applyAllToggle` in the sticky row): adds **+1 to everyone**, one-shot (auto-off after one add), toasts on arm / on add. (Remove behavior corrected above.)
> - **Sticky per-person summary row** built — each person's plate count + total, doubling as a jump-to-tile shortcut. Client-side only (§III); re-renders reactively from realtime.
> - Canonical local calc is **`computeBillBreakdown()`** → `{details, grandRaw, grandFinal, grandPlates, svcRate, discAmt}` — reused unchanged by the synced client.
>
> **Earlier (from v4):**
> - **Tallies are now an append-only event log** (`plate_events`), not a counter. Quantity = `sum(delta)`. Gives idempotency (retry-safe), per-device attribution, and undo for free.
> - **No server-side bill history.** Closed bills are purged quickly; instead each **device saves its own copy locally** on close, with a local "Past Bills" list + export. (§ new)
> - **No reopen.** Manual close is final — the bill closes when the group leaves the restaurant, and any error is caught when they pay the real bill. Auto-close is now just a janitor for abandoned rooms.
> - **Live pricing, client-side calculation.** The server only stores/syncs raw state (settings, diners, menu, events). Each device folds events → quantities and computes totals locally against the **live** price, so a price correction by anyone updates everyone instantly.

---

## 0. Implementation Handoff (start here in a fresh session)
Everything needed to build the multiplayer layer without re-deriving prior decisions.

* **Start from:** `sushi-split-v4.html` — a single-file, no-build app (Vue-free vanilla JS + Tailwind/CDN, bilingual en/Cantonese). It is fully working **offline** today; multiplayer is an additive layer.
* **Backend:** Supabase (Postgres + Realtime). Why it (vs InstantDB/Firebase) and the free-tier pause workaround are in §I, §V, §VIII.
* **Data model in the app today:** `settings` (standard/seasonal dishes, `serviceCharge`, `serviceCharge` rate via `SERVICE_RATE=0.10`, `rounding`, `discount{enabled,type,amount}`) and `tally.people[] = {name, counts:{dishId: qty}}`, both persisted via `loadSettings/saveSettings` and `loadTally/saveTally` in `localStorage`.
* **Functions to reuse unchanged:** `computeBillBreakdown()` (the canonical split math), `renderTally()`, `renderStickyNav()`, `changeDishCount()`, `recalc()`, `copyBillSummary()`.
* **The seams to replace when adding sync:**
  1. `loadTally()` → fetch `join_room(room_code)` then **fold `plate_events` → the same `counts{}` map** (dedup by `event_id`).
  2. `saveTally()` per-tap → call `tap(...)`; the apply-to-all **add** branch (`applyAll && delta > 0`) → call `tap_everyone(..., diner_ids, ...)` once with the client's current diner ids.
  3. Subscribe to `postgres_changes` on `bills/diners/menu_items/plate_events`; apply incoming events through the same fold (dedup `Set`). Wrap each write in the optimistic→retry→revert lifecycle (§II).
  4. Add connection-state handling for the **wait/fork** modes (§IV.1).
* **SQL to create:** tables in §II; functions `join_room` + the full write surface (`tap`, `tap_everyone` with validated `diner_ids[]`, `create_bill`, `add/rename/remove/claim_diner`, `add/update_menu_item`, `update_settings`, `close_bill`), `ping`; `pg_cron` jobs for auto-close + purge (§IV.2); keep-alive (§V).
* **Open decisions left to the builder:** none outstanding. `metadata`/`currency` columns are pre-added for future split-types. *(Security hardening, presence, activity-flash committed; the armed-toggle behavior is resolved — any tap consumes it.)*
* **Build order suggestion:** schema + RPCs → lobby/room-code join → `join_room` snapshot + fold → realtime subscription → tap/tap_everyone writes → wait/fork → close + local history → keep-alive cron.

---
* **Provider:** **Supabase (PostgreSQL + Realtime).**
* **Division of responsibility:**
  * **Server stores & syncs (source of truth):** bill settings, `diners`, `menu_items` (including live `price`, `kind`, `is_active`), and the `plate_events` log.
  * **Client computes (locally):** folds events → per-(diner, item) quantities, multiplies by **live** price, applies service charge + discount, runs the largest-remainder split, and renders. No server-side bill math.
  * **Result:** a price edit is just an `UPDATE menu_items.price` → realtime → every device recomputes. Tally taps are just appended events. The server never calculates a total.
* **Why Supabase:** Realtime is *not* offline-first, so a dropped connection makes writes fail rather than queue/merge — exactly what the wait/fork model wants. The 7-day pause is neutralized by the keep-alive layer (§V).
* **Trust Model:** Low-stakes, high-trust, in person. No auth; anyone with the room code reads/writes everything; open menu editing; collaborative tallying. No *user* login — the unguessable room UUID is the capability ("you know the code, you're in").
* **Security model (committed — no login, no passcode):** RLS is **on** for every table. `anon` gets table `SELECT` only (so Realtime `postgres_changes` works) and `EXECUTE` on the RPC layer; it has **no direct INSERT/UPDATE/DELETE**. *All* writes go through `security definer` RPCs that take `bill_id` and validate it (§ Write surface). This closes the "scraper wipes/corrupts all rooms" hole while keeping the app fully open to anyone with the room link. The unguessable room UUID is the capability. (If you ever want to restrict reads too, move Realtime from `postgres_changes` to **Broadcast** so tables need no `SELECT` grant — not needed for v1; reads aren't the threat.)
* **Passcode-free join:** the link/QR carries the word-pair `room_code`; the app calls `join_room(room_code)` → gets `bill_id` + full state → uses `bill_id` for all subsequent RPCs and the subscription. No one types the UUID; the word-pair is only typed in the manual-join fallback and is a friendly room name, not a secret.
* **Local Illusion:** Per-device prefs (pinned diner, language, zoom, **device id**, **saved past bills**) live in `localStorage`.

---

## II. Database Schema

### `bills` (The Room/Session)

| Column | Type | Notes |
| :--- | :--- | :--- |
| **id** | UUID | PK `default gen_random_uuid()`. |
| **room_code** | Text | Latin word-pair (`tea-red`), unique among **active** bills. ASCII even in zh UI to avoid IME friction. |
| **created_at** | Timestamptz | Session start. |
| **last_activity_at** | Timestamptz | Bumped on each tap; drives the auto-close janitor. |
| **status** | Text | `'active'` or `'closed'`. |
| **currency** | Text | e.g. `'TWD'`. Single-currency at launch, but stored so multi-currency isn't a migration later. |
| **service_charge** | Boolean | Default `true`. |
| **service_charge_rate** | Numeric | Default `10`. |
| **rounding** | Boolean | Default `false`. |
| **discount_enabled** | Boolean | Default `false`. |
| **discount_type** | Text | `'pct'` or `'fixed'`. |
| **discount_amount** | Numeric | Percentage or fixed amount. |
| **metadata** | jsonb | Default `'{}'`. Escape hatch for split-type-specific fields (lets this infra generalize to your other split tools later). |
| **base_fee** / **tax_name** | Numeric / Text | **[ROADMAP]** |

### `diners` (The People)

| Column | Type | Notes |
| :--- | :--- | :--- |
| **id** | UUID | PK. |
| **bill_id** | UUID | FK → `bills` `on delete cascade`. |
| **name** | Text | Display name. |
| **created_at** | Timestamptz | Canonical ordering key so the largest-remainder split agrees on every device. |
| **claimed_by_device** | Text | Nullable device id. Enables attribution + re-pinning "my tile" after reload; future auth seam. |
| **is_guest_of_honor** / **is_locked** / **locked_amount** | — | **[ROADMAP]** |

### `menu_items` (The Session's Live Menu)

| Column | Type | Notes |
| :--- | :--- | :--- |
| **id** | UUID | PK (surrogate — fixes the old Text-dish-id collision). |
| **bill_id** | UUID | FK → `bills` `on delete cascade`. |
| **dish_key** | Text | Stable slug like `salmon`. `UNIQUE(bill_id, dish_key)`. |
| **name** | Text | Display name. |
| **price** | Numeric(10,2) | **Live** price — edited in place, synced to all. No price history kept. |
| **kind** | Text | `'standard'` \| `'seasonal'` \| `'deal'`. |
| **is_active** | Boolean | Default `true`. Soft-delete. |
| **metadata** | jsonb | Default `'{}'`. |

### `plate_events` (Append-Only Tally Log)
Quantity for any (diner, item) is `sum(delta)`. The `-` button and undo append a **negative** delta; quantities clamp at 0 in the UI.

```sql
create table plate_events (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references bills(id)      on delete cascade,
  diner_id     uuid not null references diners(id)     on delete cascade,
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  delta        numeric not null,        -- +1, -1, +0.5 …
  event_id     text    not null unique, -- client-generated idempotency key
  by_device    text,                    -- attribution (nullable)
  created_at   timestamptz not null default now()
);
create index on plate_events (bill_id, created_at);
```

### Tap RPC (atomic, idempotent, attributed)
```sql
create or replace function public.tap(
  p_bill uuid, p_diner uuid, p_item uuid,
  p_delta numeric, p_event_id text, p_device text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into plate_events (bill_id, diner_id, menu_item_id, delta, event_id, by_device)
  values (p_bill, p_diner, p_item, p_delta, p_event_id, p_device)
  on conflict (event_id) do nothing;          -- retry-safe: a re-sent tap is a no-op

  update bills set last_activity_at = now() where id = p_bill;
end; $$;
grant execute on function public.tap(uuid, uuid, uuid, numeric, text, text) to anon;
```

### Round RPC ("add for everyone", atomic + round-level idempotency)
Inserts one event per **client-supplied** diner id, in one transaction, after validating each id belongs to this bill. The client passes the exact set it optimistically applied (`p_diner_ids`), so server and client never diverge; the `join diners` filter drops any id that isn't a current diner of this bill (stale client / removed diner / cross-bill). The whole round shares a `p_round_id`; each diner's event id is derived from it, so a retried round is a no-op. Returns the number of diners affected (for the toast).
```sql
create or replace function public.tap_everyone(
  p_bill uuid, p_item uuid, p_delta numeric,
  p_round_id text, p_diner_ids uuid[], p_device text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into plate_events (bill_id, diner_id, menu_item_id, delta, event_id, by_device)
  select p_bill, d.id, p_item, p_delta,
         p_round_id || ':' || d.id::text,   -- deterministic per-diner id within the round
         p_device
  from unnest(p_diner_ids) as req(id)
  join diners d on d.id = req.id and d.bill_id = p_bill   -- only valid diners of THIS bill
  on conflict (event_id) do nothing;        -- retried round = no-op

  get diagnostics n = row_count;
  update bills set last_activity_at = now() where id = p_bill;
  return n;
end; $$;
grant execute on function public.tap_everyone(uuid, uuid, numeric, text, uuid[], text) to anon;
```

### Join RPC (`join_room` — entry point, returns `bill_id` + full state)
The client's only entry point: resolves the word-pair to the internal `bill_id` and returns the full snapshot in one call, so no UUID is ever typed. Clients fold events themselves (see dedup pattern below).
```sql
create or replace function public.join_room(p_room text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'bill',       to_jsonb(b),                 -- includes b.id (bill_id) for subsequent RPCs
    'diners',     coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id)
                            from diners d where d.bill_id = b.id), '[]'::jsonb),
    'menu_items', coalesce((select jsonb_agg(to_jsonb(m))
                            from menu_items m where m.bill_id = b.id), '[]'::jsonb),
    'events',     coalesce((select jsonb_agg(to_jsonb(e))
                            from plate_events e where e.bill_id = b.id), '[]'::jsonb)
  )
  from bills b where b.room_code = p_room and b.status = 'active';
$$;
grant execute on function public.join_room(text) to anon;
```

### Write surface (every mutation is a `security definer` RPC)
Because `anon` has no direct table writes, all mutations go through these. Each begins by validating that `p_bill` exists and is `active` (and that any `diner_id`/`item_id` belongs to it), then performs the write. `anon` gets `EXECUTE` on each.

| RPC | Purpose |
| :--- | :--- |
| `join_room(room_code) → jsonb` | Resolve code → `bill_id` + full state (above). |
| `create_bill(host_name, currency, settings…) → jsonb` | Lobby "Start New Bill": new room, room_code, host diner; returns state. |
| `add_diner(bill_id, name) → uuid` | Add a tile; returns new `diner_id`. |
| `rename_diner(bill_id, diner_id, name)` | Rename. |
| `remove_diner(bill_id, diner_id)` | Remove a tile (cascades their events). |
| `claim_diner(bill_id, diner_id, device_id)` | Set `claimed_by_device` — drives the "joined / not joined" nag. |
| `add_menu_item(bill_id, dish_key, name, price, kind) → uuid` | New dish for this session. |
| `update_menu_item(bill_id, item_id, {name?, price?, is_active?})` | Live price/name edit, soft-delete. |
| `update_settings(bill_id, {service_charge, rate, rounding, discount_*})` | Bill settings. |
| `tap(bill_id, diner_id, item_id, delta, event_id, device)` | Single tally event (±1). |
| `tap_everyone(bill_id, item_id, +1, round_id, diner_ids, device) → int` | Add-for-all round. |
| `close_bill(bill_id)` | Final close → `status='closed'`. |

`create_bill` and `close_bill` are the only bill-lifecycle writes; `pg_cron` (auto-close/purge) runs server-side and needs no grant.

### Dedup-safe sync pattern (client)
Handles the snapshot/subscription race with no double-counting:
1. **Subscribe first** to `plate_events` (+ `diners`, `menu_items`, `bills`) for the room; buffer incoming events.
2. **Fetch** `join_room(room_code)`.
3. **Fold** snapshot events into quantities, recording each `event_id` in a `Set`.
4. **Apply** buffered + future realtime events only if their `event_id` isn't already in the `Set`.

Event volume per meal is tiny (dozens–low hundreds), so folding locally is free.

### Client write lifecycle (optimistic + idempotent retry)
The offline app writes synchronously (`saveTally()`); networked writes are async and can fail mid-flight even when the client believes it's online (transient timeout). Lifecycle for every `tap` / `tap_everyone`:
1. **Snapshot** the affected local quantities and the predicted `event_id`(s).
2. **Apply optimistically** and seed the predicted `event_id`(s) into the dedup `Set`.
3. **Call** the RPC.
4. **On success:** nothing to do — the realtime echo is deduped by the `Set`.
5. **On failure:** because the log is append-only and `event_id` makes the write idempotent, **retry once or twice silently**; if it still fails, **revert** the optimistic delta (and remove the predicted id from the `Set`) and show a subtle toast (e.g. "Network error — couldn't add dish").

This is distinct from the wait/fork modes (§IV.1), which handle a *known* disconnect by pausing writes entirely. This lifecycle handles a *believed-online* write that rejects.

### Collaborative edits (menu & settings)
* **Send on blur, not per keystroke.** The offline app already fires price/name updates on `onchange` (blur) — keep that; do **not** switch to `oninput` for synced fields, or Realtime gets a write per keystroke.
* **Last-write-wins is acceptable** for `menu_items.price` / `name` and all bill settings in this high-trust context. Per-field locking is unnecessary; two friends editing the same dish price at once is rare and self-evidently resolved at the table.

> **Continuity with the offline build:** folding `plate_events` into per-(diner, item) sums produces exactly the `counts{dish_key: qty}` shape that `sushi-split-v4.html` already uses (`tally.people[].counts`). So `computeBillBreakdown()`, `renderTally()`, and `renderStickyNav()` run **unchanged** on synced data — the sync layer just replaces `loadTally()`/`saveTally()` with "fold events" and "append an event." The local math, the sticky summary, and the apply-to-all toggle don't need to know they're networked.

---

## III. User Journey & Core UI Flows
*(Lobby/menu unchanged from v3; claiming now records server-side for the presence nag.)*
* **Lobby:** open the link/QR (carries `room_code`) → app calls `join_room` → you're in, no UUID typed. Or "Start New Bill" (`create_bill`), or manually type the word-pair. Codes are unique among active bills; curate the word list for phonetic distinctness.
* **Claiming a diner:** tap "⭐ This is me" → calls `claim_diner(bill_id, diner_id, device_id)` to set `claimed_by_device` **and** pins that diner locally to the top of your screen. The server-side claim is what powers the "joined / not joined" view (§ Presence). Double-claims are harmless (last claim wins).
* **Menu:** open editing (`add_menu_item` / `update_menu_item`); soft-delete via `is_active` with `.archived` styling; `-` warns before removing an archived plate.

### Apply-to-All / Round Toggle — ADD-ONLY  ✅ *built in `sushi-split-v4.html`*
Lets one person add an item for everyone at once — Amy orders toro and the whole table wants in. It's the `applyAllToggle` checkbox in the sticky row; `changeDishCount()` handles it. **Local UI state on the tapping device — not synced.** **Bulk applies to adds only; removes are always single-box.**

Current offline behavior (keep as-is):
* **Arm:** flipping the toggle on toasts `toastToggleOn` ("Everyone's in on this next order"); flipping off manually toasts `toastToggleOff`.
* **Add (`+`) while armed:** applies `+1` to **every** person, then auto-disarms (one-shot). Toast `toastAddAllAndOff`.
* **Remove (`−`) while armed:** affects **only the clicked box** — a normal single-box decrement — **and consumes the toggle (disarms it)**, with a `toastRemoveOne` toast ("Remove one at a time" / "減就一個一個嚟").
* **One-shot safety:** the first `+` consumes the armed state, so a stray second tap is an ordinary single add to the tapper — no accidental double round.

> **Resolved decision:** **any** dish tap while armed consumes the one-shot toggle — an add fires the round, a remove does a single-box decrement and disarms. Rationale: a lingering armed toggle is the real footgun (an unrelated next tap could fire an unintended round), so disarming on any interaction is the safer default. The rare "I meant to add a round but hit `−` first and lost the toggle" case is caught when plates are counted at the table.

Mapping to the synced version (the only change when porting):
* An armed **add** becomes **one** `tap_everyone(bill, item, +1, round_id, diner_ids, deviceId)` call — an atomic batch with a round-level idempotency key — replacing the `tally.people.forEach(...)` loop in the `applyAll && delta > 0` branch. **Pass the exact `diner_ids` the client optimistically applied** so the server commits to the same set (no late-joiner divergence); the RPC validates each id against the bill.
* Every **remove**, and every non-armed single add, is a normal single `tap(bill, diner, item, ±1, event_id, deviceId)` — `tap_everyone` is **only ever called with `+1`**.
* **Canonical diner order** everywhere (split math + render) is `created_at, id` — the `id` tiebreak keeps the largest-remainder leftover cent on the same person across all devices even if two join in the same millisecond.
* Optimistically apply the round to every diner locally, seeding the predicted event ids (`round_id:diner_id`) into the dedup `Set` so the realtime echoes don't double-apply.
* **Offline:** blocked like any write (wait/fork rules) — disarm and toast that a round can't be added while reconnecting.
* **Attribution:** all events in the round carry the tapper's `by_device`.
* **Expected, not a bug:** two people each adding a round of the same item → everyone gets +2 (two real rounds); the post-add toast surfaces it.

### Sticky Per-Person Summary + Jump Nav  ✅ *built in `sushi-split-v4.html`*
A sticky row showing each person's plate count + running total, doubling as a tap-to-scroll shortcut to that person's tile (`renderStickyNav()` → smooth-scrolls to `person-card-{idx}`). It also hosts the apply-to-all toggle.

* **Client-side only — no backend work.** Derived entirely from `computeBillBreakdown()`, the same calc that produces the bill, so the summary can never disagree with the totals.
* **In the synced version** it re-renders whenever realtime changes (new events, price edits, joins/leaves) land — no extra queries, no server state. Each device renders its own row (and pins its own diner to the front via `claimed_by_device`).

### Presence — "who's here / who hasn't joined"  ⭐ *committed*
Uses Supabase Realtime **Presence** (no schema beyond the existing `claimed_by_device`). Each connected device tracks `{ device_id, diner_id (claimed, or null) }` on the room's presence channel. From that, the UI derives three states per diner tile:
* **Joined & present** → small green dot (a present device has claimed this diner).
* **Joined, currently away** → claimed (`claimed_by_device` set) but no present device → grey/idle dot.
* **Not joined yet** → `claimed_by_device` is null → a clear "not joined" badge, **so the table can nag them to open the link.** A count in the sticky row ("2 not joined") makes the nudge obvious.

Bonus: presence also lets auto-close fire on an *empty* room (no present devices) instead of relying only on the blunt idle timer.

### Activity flash  ⭐ *committed*
When a realtime event arrives from a **different** `by_device`, briefly pulse that dish cell's background (e.g. `var(--accent-glow)`) so someone scrolled away can see a plate was added to their row. Gate strictly to other devices so your own taps don't flash.

---

## IV. Edge Cases & Lifecycle Management
### 1. Offline Handling — two clean modes, no auto-merge
* **① Wait (read-only):** writes **paused, not queued**; banner shows "reconnecting — tallying paused"; last-known state stays visible; on reconnect, re-snapshot via `join_room` and resume. Nothing buffered → nothing merges.
* **② Go offline (fork):** snapshot current state into a **local-only** bill badged "OFFLINE COPY — not synced"; standalone calculator, no automatic path back; offer export to reconcile by hand.
* **Tip:** personal-record keepers should fork from the start, leaving only the online consolidator writing to the shared table.

### 2. Closing the Bill (final — no reopen)
* **Manual Close** is the normal path: the group is done/leaving, real bill paid, errors already caught. Host (or anyone) clicks "Finish & Close" → `status = 'closed'`, UI locks for everyone.
* **On close, prompt each device:** "Save a copy to this device?" → writes the locally-computed final split to local history (§ below). The server keeps **no** record.
* **Auto-close (janitor only):** a `pg_cron` job closes `active` bills idle beyond a window (e.g. 3h) so abandoned rooms don't hold a `room_code`. No manual/auto distinction needed since there's no reopen.
* **Retention:** purge closed bills (events cascade) shortly after close — the server isn't a system of record.

```sql
select cron.schedule('close-idle-bills', '*/30 * * * *', $$
  update bills set status = 'closed'
  where status = 'active' and last_activity_at < now() - interval '3 hours';
$$);

select cron.schedule('purge-closed-bills', '0 * * * *', $$
  delete from bills where status = 'closed' and last_activity_at < now() - interval '1 day';
$$);
```

---

## V. Local Bill History & Export (client-side, offline)
The system of record is the **user's device**, not the server.

* **On close:** the computed final split (per-diner totals, plate counts, settings snapshot, currency, timestamp, optional restaurant label) is offered for saving to `localStorage` (e.g. key `sushi_bill_history`, an array of records).
* **Past Bills screen:** lists saved bills; tap to view the frozen summary; nothing hits the network.
* **Export:** per bill as JSON download and copyable text (reuse the existing `copyBillSummary` formatting); image/screenshot optional later.
* Because the snapshot is computed and stored client-side at close time, it always reflects the math used then, with no server dependency.

---

## VI. Keep-Alive Architecture (defeating the 7-day pause)
Any real dinner session resets the inactivity clock; the keep-alive only covers dry spells.

* **Heartbeat RPC** (`public.ping()`, `security definer`, performs a real write).
* **GitHub Actions cron** every 2 days (`0 9 */2 * *`) POSTing to `/rest/v1/rpc/ping` with repo-secret URL + anon key.
* **Redundant UptimeRobot monitor** hitting the same endpoint as backup (a single pinger can silently fail; GH also disables schedules after ~60 days of no commits).
* 2-day interval leaves a 5-day buffer; a cold start (~30s) only costs latency, never data.

*(SQL/YAML unchanged from v3.)*

---

## VII. Future Roadmap
1. **Fractional Sharing** — `delta` is already numeric, so half-plates work today; UI is the only lift.
2. **Base Fees & Dynamic Tax** — `base_fee`, `tax_name`.
3. **Paid & Locked Leavers** — `locked_amount` snapshot at lock time.
4. **Guest of Honor** — subsidize one diner; apply lock snapshots before redistribution.
5. **Community Presets** — `menu_presets` + `preset_items`.
6. **Unified split backend** — `metadata` jsonb + domain-neutral shape let this host your group-buy / other split tools later.

---

## VIII. Backend Decision Record
| Option | Verdict |
| :--- | :--- |
| **InstantDB** | ❌ Offline-first by default — auto-queues/merges offline writes, the opposite of the wait/fork model. |
| **Supabase** | ✅ **Chosen.** Realtime isn't offline-first → full control on disconnect; relational schema preserved; client-side calc keeps the server to pure sync. Cost: 7-day pause, neutralized by keep-alive (§VI). Free ceilings (200 realtime conns, 500MB) far exceed a dinner table. |
| **Firebase Firestore** | ⚠️ Never pauses, but NoSQL + offline-first by default. |
