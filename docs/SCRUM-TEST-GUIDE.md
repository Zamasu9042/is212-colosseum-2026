# How to test SCRUM-21, SCRUM-22 and SCRUM-24

Each story can be tested two ways:

- **Automated.** One command runs the story's Jest unit and integration tests against the
  database.
- **Manual (GUI).** Step-by-step test cases with exact inputs and the expected result,
  using the demo data. Every case below was executed in a browser against fresh demo data
  and passed.

## 0. One-time setup

```bash
npm install
cp .env.example .env
docker compose up -d        # or your own PostgreSQL
npm run setup               # schema + roles + demo data
npm start                   # http://localhost:4000
```

**Reset before each story's manual tests.** The cases in a section build on each other, and
each section expects untouched demo data:

```bash
npm run db:reset && npm run db:demo
```

Sign in as **Technical Support** for every manual case. On the login page, open *Demo
accounts* and click **Technical Support** (`tech@demo.connectsphere.sg` / `Passw0rd1`).
The first time, a *Getting started* tour opens. Press **Skip tour** or complete it.

### Demo data the test cases use

| Equipment | Type | Units | Status at start |
|---|---|---|---|
| Epson 4K Projector #1 | Projector | 1 | **Reserved** (for Annual Leadership Summit) |
| Epson 4K Projector #2 | Projector | 1 | Available |
| Epson 4K Projector #3 | Projector | 1 | **In repair** |
| 85" LED Display | Display | 1 | **Unavailable** |
| Shure Wireless Mic Set | Audio | 6 | Available |
| Bose PA System | Audio | 1 | Available |
| Presenter Laptops | Computing | 8 | Available |
| Livestream Camera Kit | Video | 1 | Available |

| Event (all 14 days after the demo data is loaded) | Time (SGT) | Venue | Equipment requested |
|---|---|---|---|
| Annual Leadership Summit | 9:00 AM–5:00 PM | not set | 2 × Projector (1 allocated: #1), 4 × Shure Wireless Mic Set, 1 × Bose PA System |
| Product Launch Gala | 4:00 PM–9:00 PM | Marina Grand Hall | 1 × Projector |
| Customer Training Day | 5:00 PM–7:00 PM | Harbourfront Seminar Room | — |

Times are shown in your computer's time zone. The values above assume Singapore time.

### Run every automated test

```bash
npm test          # all suites (needs the database from step 0)
```

---

## SCRUM-22: Manage Equipment Catalogue Status

> As Technical Support Staff, I want to update the status of equipment items so that only
> working, unreserved equipment can be assigned.

### Automated

```bash
npx jest tests/equipment.status.test.js                    # 21 integration tests
npx jest tests/equipmentAvailability.test.js -t "SCRUM-22" # 10 unit tests
```

| AC | Integration test block | Unit test block |
|---|---|---|
| AC1 Remove in-repair/unavailable items from selectable lists | `AC1 — in-repair / unavailable items are removed from selectable reservation lists` | `SCRUM-22 AC1/AC2` |
| AC2 Error + block when reserving in-repair/unavailable | `AC2 — reservations on in-repair / unavailable items are blocked with an error` | `SCRUM-22 AC1/AC2` |
| AC3 Filter catalogue by status | `AC3 — catalogue can be filtered by status` | `SCRUM-22 AC3` |

### Manual test cases

Reset the demo data first.

| ID | AC | Steps | Expected result |
|---|---|---|---|
| TC-22-1 | AC3 | 1. Click **Equipment catalogue**. 2. Click the **Available (5)** chip. 3. Click **In repair (1)**. 4. Click **Unavailable (1)**. | Step 2 lists exactly 5 items, all *Available*: Bose PA System, Epson 4K Projector #2, Livestream Camera Kit, Presenter Laptops, Shure Wireless Mic Set. Step 3 lists only **Epson 4K Projector #3**. Step 4 lists only **85" LED Display**. |
| TC-22-2 | AC1 | 1. In **Equipment catalogue** click **All (8)**, then tick **Reservable items only**. 2. Go to **Events & reservations** → **Annual Leadership Summit** → **+ Reserve equipment**. Open the **Item** dropdown. | Step 1 shows 6 items. **Epson 4K Projector #3** and **85" LED Display** are not listed. Step 2's dropdown lists Bose PA System, Epson 4K Projector #2, Livestream Camera Kit, Presenter Laptops and Shure Wireless Mic Set. It does **not** list #3 (in repair), the LED Display (unavailable), or #1 (already reserved for this window). Close the dialog. |
| TC-22-3 | AC2 | 1. **Equipment catalogue** → click **Epson 4K Projector #3**. 2. Click **Reserve for an event**, choose **Annual Leadership Summit**, press **Reserve**. | Step 1 shows an orange banner: *"This item is in repair…"*. Step 2 shows a red error in the dialog: **"Epson 4K Projector #3 is in repair and cannot be reserved."** After closing the dialog, the item's *Reservations* table is still empty. |
| TC-22-4 | AC1 + AC2 (status update takes effect) | 1. **Equipment catalogue** → in **Livestream Camera Kit**'s *Set status* column choose **Unavailable**. 2. Open **Annual Leadership Summit** → **+ Reserve equipment** → open **Item**. | Step 1 shows the toast *"Livestream Camera Kit is now unavailable."* and the chip now reads **Unavailable (2)**. Step 2: the camera kit is no longer in the list. *(Optional clean-up: set it back to Available.)* |

---

## SCRUM-21: Reserve Equipment for an Event

> As Technical Support Staff, I want to reserve specific equipment items for a confirmed event
> so that equipment is guaranteed available without double-booking.

### Automated

```bash
npx jest tests/equipment.reservation.test.js               # 29 integration tests
npx jest tests/equipmentAvailability.test.js -t "SCRUM-21" # 11 unit tests
```

| AC | Integration test block | Unit test block |
|---|---|---|
| AC1 Available → reserved for the approved event's window | `AC1 — status changes from available to reserved…` | `SCRUM-21 AC1/AC5` |
| AC2 Conflict message for overlapping windows | `AC2 — overlapping reservations are prevented…` (includes a concurrency test: 3 simultaneous requests for the last unit, exactly one wins) | `SCRUM-21 AC2` |
| AC3 Event ID, equipment ID, organiser name, timestamp | `AC3 — each reservation carries…` | — |
| AC4 Shown on event and equipment detail pages | `AC4 — reservations appear on the event detail page and the equipment detail page` | — |
| AC5 Cancel reverts reserved → available | `AC5 — cancelling reverts the item from reserved to available` | `SCRUM-21 AC1/AC5` |

### Manual test cases

Reset the demo data first. Run in order.

| ID | AC | Steps | Expected result |
|---|---|---|---|
| TC-21-1 | AC1, AC3, AC4 | 1. **Events & reservations** → **Annual Leadership Summit**. 2. Click **+ Reserve equipment**. Keep *Time window* = **Whole event**, choose Item **Epson 4K Projector #2 · Projector · 1 free**, Quantity **1**, press **Reserve**. 3. Check the **Equipment reservations** table. 4. Go to **Equipment catalogue**. 5. Click **Epson 4K Projector #2**. | Step 2 shows the toast **"1 × Epson 4K Projector #2 reserved. Item status: Reserved."** Step 3 has a new row: item *Epson 4K Projector #2*, Qty *1*, time window *9:00 AM–5:00 PM* on the Summit date, Organiser **Jane Tan**, Reserved *(now)* **by Kevin Ong**, status **Active**. Step 4: Projector #2's status is **Reserved**. Step 5: its *Reservations* table shows the same reservation for **Annual Leadership Summit**, organiser Jane Tan. |
| TC-21-2 | AC2 | 1. **Equipment catalogue** → **Epson 4K Projector #1**. 2. Click **Reserve for an event**, choose **Product Launch Gala** (4–9 PM, which overlaps the Summit's 9 AM–5 PM), press **Reserve**. | Red error in the dialog: **"Conflict: Epson 4K Projector #1 is already reserved for an overlapping time window (Annual Leadership Summit). 0 of 1 unit(s) free in this window; 1 requested."** It is followed by a bullet naming the Summit and its time window. After closing, Projector #1 still has only its original reservation. |
| TC-21-3 | AC5 | 1. Open **Annual Leadership Summit**. 2. In **Equipment reservations**, click **Cancel** on the *Epson 4K Projector #2* row (from TC-21-1). 3. Enter reason `Testing cancel` and press **Cancel reservation**. 4. Go to **Equipment catalogue**. | Step 3 shows the toast **"Reservation cancelled. Epson 4K Projector #2 is now available."** The row stays, greyed out, as **Cancelled**, with the time, *by Kevin Ong — Testing cancel*. Step 4: Projector #2 is **Available** again. |

---

## SCRUM-24: Reserve Equipment for Approved Event Window

> As Technical Support Staff, I want to reserve specific equipment items for an event without
> calculating transit times so that equipment is allocated cleanly by time-slot.

### Automated

```bash
npx jest tests/equipment.readiness.test.js                 # 22 integration tests
npx jest tests/equipmentAvailability.test.js -t "SCRUM-24" # 10 unit tests
```

| AC | Integration test block | Unit test block |
|---|---|---|
| AC1 Block reservations overlapping existing time-slots | `AC1 — reservations overlapping existing event time-slots are blocked` | `SCRUM-24 AC1/AC2` |
| AC2 No transit/buffer time between venues | `AC2 — no transit or buffer time between different venue locations` | `SCRUM-24 AC1/AC2` |
| AC3 Full allocation required for technical readiness | `AC3 — technical readiness requires full equipment allocation` | `SCRUM-24 AC3` |

### Manual test cases

Reset the demo data first. Run in order.

| ID | AC | Steps | Expected result |
|---|---|---|---|
| TC-24-1 | AC1 | 1. Open **Annual Leadership Summit**. On the **2 × Projector** line press **Allocate**, keep **Epson 4K Projector #2 · Projector · 1 free**, press **Reserve**. 2. **Equipment catalogue** → **Epson 4K Projector #2** → **Reserve for an event** → **Product Launch Gala** (a different venue: Marina Grand Hall) → **Reserve**. | Step 1: the toast confirms the reservation and the line shows **2 of 2**. Step 2: red error **"Conflict: Epson 4K Projector #2 is already reserved for an overlapping time window (Annual Leadership Summit)…"**. The overlap is blocked even though the events are at different venues. |
| TC-24-2 | AC2 | 1. **Events & reservations** → **Customer Training Day** (5:00–7:00 PM at Harbourfront Seminar Room, which has 30 min setup time). 2. Click **+ Reserve equipment** and open **Item**. 3. Choose **Epson 4K Projector #1 · Projector · 1 free** and press **Reserve**. | Step 2: **Epson 4K Projector #1 is offered**, even though it is reserved for the Summit until 5:00 PM. No travel or setup buffer is added. Step 3 shows the toast **"1 × Epson 4K Projector #1 reserved. Item status: Reserved."** |
| TC-24-3 | AC3 | 1. Open **Annual Leadership Summit** and press **Mark technical readiness complete**. 2. On **4 × Audio** press **Allocate**. Check that Quantity is pre-filled with **4**, then press **Reserve**. 3. On **1 × Audio** press **Allocate** → **Reserve**. 4. Press **Mark technical readiness complete**. 5. In **Equipment reservations**, **Cancel** the *Bose PA System* row → **Cancel reservation**. | Step 1: red error **"Technical readiness cannot be completed until all requested equipment is allocated (Audio: 0/4; Audio: 0/1)."** Readiness stays *pending*. Step 4: green **"Marked complete on …. All requested equipment is allocated."** The header pill reads **Technically ready**. Step 5: toasts **"Reservation cancelled. Bose PA System is now available."** and **"Technical readiness went back to pending — a requirement is no longer fully allocated."** The header returns to *Technical readiness pending*. |

---

## Test case template (for adding more)

| Field | Content |
|---|---|
| ID | TC-&lt;story&gt;-&lt;n&gt; |
| Story / AC | e.g. SCRUM-21 AC2 |
| Preconditions | Demo data reset; signed in as Technical Support |
| Steps | Numbered clicks and inputs |
| Test data | Exact item/event names, quantities, times |
| Expected result | Exact message / status / row content |
| Actual result / Pass-Fail | Filled in when run |

## Related regression tests (October bug review)

`tests/bugfixes.equipment.test.js` also covers SCRUM-21/22/24 edge cases found in review:
- an item goes back to Available after its last reservation ends
- reserving a window that has already ended is refused
- items later put in repair stop counting towards readiness
- units in service can't drop below what is already reserved

Run with `npx jest tests/bugfixes`.
