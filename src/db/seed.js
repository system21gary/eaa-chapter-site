import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { absoluteUrl } from '../middleware/base-path.js';
import db, { get, run, nowIso } from './index.js';
import { migrate } from './migrate.js';
import * as Users from '../models/users.js';
import * as Posts from '../models/posts.js';
import * as Tools from '../models/tools.js';
import * as Events from '../models/events.js';
import * as Builds from '../models/builds.js';
import * as Applications from '../models/applications.js';
import { processImage } from '../lib/images.js';
import { sceneSvg, toolSvg, renderPng } from './placeholder-art.js';

/**
 * Demo content.
 *
 * Everything here except the May 2026 pancake breakfast is invented, so the
 * site has something to look at on first run. The people are fictional; the
 * airport, the chapter and that one event are real.
 *
 * Note what this script does NOT do: it never sets a password. Seeded accounts
 * are created with password_hash NULL, exactly like a real invitation, and the
 * only way into any of them is a one-time reset link. The admin's link is
 * printed at the end.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'gary.jones@hawthorncs.com';

/* Dates are anchored to "now" so the demo never looks stale. */
const now = new Date();
function daysAgo(n, hour = 12, minute = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
function daysAhead(n, hour = 12, minute = 0) {
  return daysAgo(-n, hour, minute);
}

async function art(kind, seed) {
  const svg = kind === 'tool' ? toolSvg(seed) : sceneSvg(seed);
  return processImage(await renderPng(svg), { folder: kind === 'tool' ? 'tools' : 'builds' });
}

async function realPoster() {
  const file = path.join(config.publicDir, 'img', 'pancake-breakfast-2026.png');
  try {
    return await processImage(await fs.readFile(file), { folder: 'events' });
  } catch {
    return art('scene', 'pancake-breakfast');
  }
}

function alreadySeeded() {
  return get('SELECT COUNT(*) AS n FROM tools').n > 0 || get('SELECT COUNT(*) AS n FROM builds').n > 0;
}

/* ========================================================================= */

async function seed() {
  migrate({ quiet: true });

  if (alreadySeeded() && process.env.FORCE_SEED !== '1') {
    console.log('[seed] content already present — nothing to do.');
    console.log('       Re-run with FORCE_SEED=1 to add it anyway, or `npm run reset` first.');
    return;
  }

  console.log('[seed] building demo content…');

  /* ------------------------------------------------------------- people */

  const people = [
    {
      key: 'gary',
      email: ADMIN_EMAIL,
      firstName: 'Gary',
      lastName: 'Jones',
      role: 'admin',
      aircraft: null,
      homeBase: 'South Albany (4B0)',
      bio: 'Chapter webmaster. Ask me why the site is down; the answer is usually "it is not, try a hard refresh".',
    },
    {
      key: 'dave',
      email: 'dave.kowalczyk@example.org',
      firstName: 'Dave',
      lastName: 'Kowalczyk',
      role: 'editor',
      aircraft: '1946 Aeronca 7AC Champ',
      homeBase: 'South Albany (4B0)',
      eaaNumber: '448120',
      bio: 'Restored a Champ over eleven winters. Technical Counselor. Will talk about fabric until you leave.',
    },
    {
      key: 'marta',
      email: 'marta.reyes@example.org',
      firstName: 'Marta',
      lastName: 'Reyes',
      role: 'editor',
      aircraft: "Van's RV-7A (building)",
      homeBase: 'South Albany (4B0)',
      eaaNumber: '1092774',
      bio: 'Structural engineer by day, riveter by night. Chapter newsletter editor.',
    },
    {
      key: 'bill',
      email: 'bill.trotter@example.org',
      firstName: 'Bill',
      lastName: 'Trotter',
      role: 'member',
      aircraft: 'Piper PA-18 Super Cub',
      homeBase: 'South Albany (4B0)',
      bio: 'A&P, 40 years. If it leaks, I have probably fixed one.',
    },
    {
      key: 'ken',
      email: 'ken.ishikawa@example.org',
      firstName: 'Ken',
      lastName: 'Ishikawa',
      role: 'member',
      aircraft: 'Sonex Waiex-B (building)',
      homeBase: 'Garage, Delmar NY',
      bio: 'Two-car garage, one-car build. Year four and counting.',
    },
    {
      key: 'sue',
      email: 'sue.delaney@example.org',
      firstName: 'Sue',
      lastName: 'Delaney',
      role: 'member',
      aircraft: 'Cessna 170B',
      homeBase: 'South Albany (4B0)',
      bio: 'Young Eagles coordinator. Flown 200+ kids and counting.',
    },
    {
      key: 'tom',
      email: 'tom.vasquez@example.org',
      firstName: 'Tom',
      lastName: 'Vasquez',
      role: 'member',
      aircraft: 'Zenith CH 750 Cruzer (building)',
      homeBase: 'Hangar 6, 4B0',
      bio: 'Retired lineman. Building something that can land on the back field.',
    },
    {
      key: 'nora',
      email: 'nora.bellweather@example.org',
      firstName: 'Nora',
      lastName: 'Bellweather',
      role: 'member',
      aircraft: 'Student pilot — Ray Scholarship recipient',
      homeBase: 'South Albany (4B0)',
      bio: 'Seventeen, soloed in March, still cannot quite believe it.',
    },
  ];

  const users = {};
  for (const p of people) {
    const existing = Users.findByEmail(p.email);
    const user =
      existing ??
      Users.createUser({
        email: p.email,
        firstName: p.firstName,
        lastName: p.lastName,
        role: p.role,
        status: 'pending',
        aircraft: p.aircraft,
        homeBase: p.homeBase,
        eaaNumber: p.eaaNumber ?? null,
      });
    Users.updateProfile(user.id, { bio: p.bio });
    // Demo members appear active so the directory looks alive; they still have
    // no password, so nobody can actually sign in as them.
    Users.setStatus(user.id, 'active');
    Users.setRole(user.id, p.role);
    users[p.key] = Users.findById(user.id);
  }
  console.log(`[seed] ${people.length} members`);

  /* --------------------------------------------------------- categories */

  const categories = [
    ['sheet-metal', 'Sheet metal', '🔩', 1],
    ['hand-tools', 'Hand tools', '🔧', 2],
    ['power-tools', 'Power tools', '⚡', 3],
    ['engine', 'Engine & prop', '⚙️', 4],
    ['avionics', 'Avionics & wiring', '📡', 5],
    ['fabric-paint', 'Fabric & paint', '🎨', 6],
    ['measuring', 'Measuring & test', '📏', 7],
    ['lifting', 'Lifting & moving', '🏗️', 8],
  ];
  for (const [slug, label, icon, sort] of categories) {
    run('INSERT OR IGNORE INTO tool_categories (slug, label, icon, sort) VALUES (?, ?, ?, ?)', [
      slug,
      label,
      icon,
      sort,
    ]);
  }
  const catId = (slug) => get('SELECT id FROM tool_categories WHERE slug = ?', [slug]).id;

  /* ------------------------------------------------------------- tools */

  const toolSeed = [
    {
      owner: 'marta',
      category: 'sheet-metal',
      name: 'Pneumatic rivet squeezer',
      brand: 'Cleaveland',
      model: 'Main Squeeze',
      description:
        'The good one. Comes with 1.5", 2", 3" and 4" yokes plus a full set of dies in the fitted case.\n\nRuns happily off a pancake compressor at 90 psi. Please do not adjust the depth stop without telling me — I have it set for AN470AD4 and it takes a while to dial back in.',
      condition: 'excellent',
      loanTerms:
        'Happy to lend for a week or two. Bring it back in the case with all the yokes. If a die walks off, they are about $18 to replace and I will not be cross, I will just want to know.',
      locationLabel: 'Hangar 12, South Albany (4B0)',
      locationNotes: 'Red rolling cabinet, second drawer down. Cabinet key hangs on the nail behind the door.',
      requiresCheckout: 1,
      deposit: 'None',
    },
    {
      owner: 'marta',
      category: 'sheet-metal',
      name: '3X rivet gun + bucking bar set',
      brand: 'Taylor',
      model: '3X with regulator',
      description:
        'Rivet gun with a proper regulator on the handle, three sets, and five tungsten bucking bars in various awkward shapes — including the one that fits the tailcone bulkhead, which is the whole reason anybody borrows this.',
      condition: 'good',
      loanTerms: 'A weekend at a time. Tape the sets before you use them, please.',
      locationLabel: 'Hangar 12, South Albany (4B0)',
      availability: 'on-loan',
    },
    {
      owner: 'bill',
      category: 'lifting',
      name: 'Engine hoist, 2-ton folding',
      brand: 'Torin',
      model: 'T32002X',
      description:
        'Folding shop crane. Handles an O-320 or O-360 with the chain hoist attached without complaint.\n\nIt is heavy and it does not fit in a sedan. Bring a pickup or a trailer.',
      condition: 'good',
      loanTerms:
        'Yours for as long as you need it, but tell me roughly, because there is usually somebody else waiting. Grease the ram before you return it and we are square.',
      locationLabel: 'Bill\'s barn, 4 miles from the field',
      locationNotes: 'Call before you come out — the dog is friendly but loud.',
      deposit: 'None, but a six-pack has been known to change hands',
    },
    {
      owner: 'dave',
      category: 'measuring',
      name: 'Digital torque wrench, 3/8"',
      brand: 'Snap-on',
      model: 'TECH2FR100',
      description:
        '5–100 ft-lb, calibrated February this year, certificate in the case. Reads in ft-lb, in-lb and Nm.\n\nThis is the wrench for prop bolts and cylinder base nuts. Please do not use it as a breaker bar. I will know.',
      condition: 'excellent',
      loanTerms: 'Overnight or a weekend. Never use it to loosen anything.',
      locationLabel: 'Hangar 3, South Albany (4B0)',
      requiresCheckout: 1,
      manualUrl: 'https://www.snapon.com/',
    },
    {
      owner: 'ken',
      category: 'sheet-metal',
      name: 'Dimpling C-frame and die set',
      brand: 'Avery',
      model: 'C-frame',
      description:
        'C-frame, spring-loaded pin, and dies for #30 and #40 in both flush and dimple-die flavours. Bolts to any decent bench.\n\nBring your own deadblow. Mine has taken enough abuse.',
      condition: 'good',
      loanTerms: 'A month is fine. It is not doing anything at mine between wing skins.',
      locationLabel: 'Ken\'s garage, Delmar',
    },
    {
      owner: 'ken',
      category: 'sheet-metal',
      name: 'Sheet metal brake, 48"',
      brand: 'Grizzly',
      model: 'T10151',
      description:
        'Bench-mounted 48" box and pan brake. Good up to 16 gauge mild steel, easily handles .032 and .040 aluminium.\n\nHeavy. Two people to move it, and I mean two actual people.',
      condition: 'fair',
      loanTerms: 'Come and use it at mine rather than moving it, honestly. Coffee provided.',
      locationLabel: 'Ken\'s garage, Delmar',
      availability: 'unavailable',
    },
    {
      owner: 'bill',
      category: 'engine',
      name: 'Differential compression tester',
      brand: 'ATS',
      model: 'E2M',
      description:
        'Proper differential tester with the master orifice, not the cheap auto-parts one. Includes the adapter for 14mm and 18mm plugs.\n\nI will come and run the test with you if you want — it is easy to get a misleading number if the engine is not warm and the prop is not held properly.',
      condition: 'excellent',
      loanTerms: 'Ask and I will usually just come and do it with you. Safer that way.',
      locationLabel: 'Hangar 8, South Albany (4B0)',
      requiresCheckout: 1,
    },
    {
      owner: 'dave',
      category: 'fabric-paint',
      name: 'Poly-Fiber covering starter kit + irons',
      brand: 'Poly-Fiber',
      description:
        'Two calibrated covering irons, a heat gun, pinking shears, rib-stitching needles, and the full set of squeegees. Everything except the chemicals, which you will need to buy fresh anyway.\n\nCome and talk to me before you start a covering job. There is a right order to do things in and the manual does not stress it enough.',
      condition: 'good',
      loanTerms: 'Long-term loan is fine for a covering project — those take months. Just keep in touch.',
      locationLabel: 'Hangar 3, South Albany (4B0)',
      requiresCheckout: 1,
    },
    {
      owner: 'tom',
      category: 'avionics',
      name: 'Avionics crimp tool set',
      brand: 'DMC',
      model: 'AFM8 with positioners',
      description:
        'The real DMC AFM8 with turret head, plus positioners for D-sub and circular connectors. Also a decent pair of Molex crimpers for the fat stuff.\n\nThis is the difference between a panel that works and a panel that works until you fly through turbulence.',
      condition: 'excellent',
      loanTerms: 'A week. Do not lend it on to anybody else — send them to me.',
      locationLabel: 'Hangar 6, South Albany (4B0)',
    },
    {
      // Owned by the admin account, so a freshly seeded site shows the borrow
      // workflow from the owner's side the moment you sign in.
      owner: 'gary',
      category: 'measuring',
      name: 'USB borescope / inspection camera',
      brand: 'Teslong',
      model: 'NTS300 with articulating tip',
      description:
        'Two-way articulating borescope with its own screen — no phone or laptop needed. The 3.9mm probe gets through a spark plug hole comfortably.\n\nGood for cylinder walls, valve faces, and finding the thing you dropped inside the wing.',
      condition: 'excellent',
      loanTerms:
        'Take it for a week. The only thing I ask is that you coil the probe rather than folding it — that is how they die.',
      locationLabel: 'Clubhouse cabinet, South Albany (4B0)',
      locationNotes: 'Top shelf, black case marked "borescope". Sign the sheet on the door.',
    },
    {
      owner: 'sue',
      category: 'engine',
      name: 'Dynamic prop balancer',
      brand: 'DynaVibe',
      model: 'GX3',
      description:
        'Dynamic propeller balancer with the tach sensor and magnetic accelerometer mount. Takes about an hour to get a prop from 0.4 IPS down to under 0.05.\n\nThe difference in the cabin is genuinely remarkable, and your instruments will thank you.',
      condition: 'excellent',
      loanTerms: 'Weekend loan. I am usually happy to come and help — it is a two-person job anyway.',
      locationLabel: 'Hangar 1, South Albany (4B0)',
      requiresCheckout: 1,
      manualUrl: 'https://www.rpxtech.com/',
    },
  ];

  const toolIds = {};
  for (const t of toolSeed) {
    const id = Tools.createTool({
      ownerId: users[t.owner].id,
      categoryId: catId(t.category),
      name: t.name,
      brand: t.brand ?? null,
      model: t.model ?? null,
      description: t.description,
      condition: t.condition,
      availability: t.availability ?? 'available',
      locationLabel: t.locationLabel ?? null,
      locationNotes: t.locationNotes ?? null,
      latitude: config.site.airport.latitude,
      longitude: config.site.airport.longitude,
      loanTerms: t.loanTerms ?? null,
      requiresCheckout: t.requiresCheckout ?? 0,
      deposit: t.deposit ?? null,
      manualUrl: t.manualUrl ?? null,
    });
    toolIds[t.name] = id;

    // Two generated photos each, so the carousel has something to do.
    for (let i = 0; i < 2; i += 1) {
      const img = await art('tool', `${t.name}-${i}`);
      Tools.addImage(id, {
        fullPath: img.fullPath,
        thumbPath: img.thumbPath,
        alt: `${t.name} on the bench`,
        width: img.width,
        height: img.height,
      });
    }
  }
  console.log(`[seed] ${toolSeed.length} tools`);

  /* -------------------------------------------------------- borrow flow */

  const squeezerId = toolIds['Pneumatic rivet squeezer'];
  const gunId = toolIds['3X rivet gun + bucking bar set'];

  run(
    `INSERT INTO borrow_requests (tool_id, requester_id, message, needed_from, needed_to, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [
      squeezerId,
      users.tom.id,
      'Closing the left wing on the Cruzer next weekend and my hand squeezer is not reaching the rear spar rivets. Could I borrow this Friday through Sunday? Happy to come and collect.',
      daysAhead(4),
      daysAhead(6),
      daysAgo(2, 20, 15),
    ]
  );

  run(
    `INSERT INTO borrow_requests (tool_id, requester_id, message, needed_from, needed_to, status, owner_reply, created_at, responded_at)
     VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
    [
      gunId,
      users.ken.id,
      'Starting on the Waiex tailcone and I only have a 2X. Any chance of the 3X and the tungsten bars for a couple of weeks?',
      daysAgo(9),
      daysAhead(5),
      'Of course — it is in the cabinet, help yourself. Take the little offset bar too, you will want it for the aft bulkhead.',
      daysAgo(11, 18, 30),
      daysAgo(10, 8, 5),
    ]
  );
  run(
    `INSERT INTO borrow_requests (tool_id, requester_id, message, needed_from, needed_to, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [
      toolIds['USB borescope / inspection camera'],
      users.nora.id,
      'My instructor wants me to look inside the cylinders on the 152 before the next annual so I actually understand what a compression test is telling me. Could I borrow the borescope for a weekend? Bill said he would sit with me while I use it.',
      daysAhead(2),
      daysAhead(4),
      daysAgo(1, 19, 5),
    ]
  );
  console.log('[seed] 3 borrow requests');

  /* ------------------------------------------------------------ builds */

  const buildSeed = [
    {
      owner: 'marta',
      title: "Marta's RV-7A",
      aircraftType: "Van's RV-7A",
      tailNumber: 'N714MR',
      buildKind: 'kit',
      status: 'building',
      percentComplete: 62,
      startedOn: daysAgo(1180),
      engine: 'Lycoming O-360-A1A, 180 hp, Hartzell constant speed',
      panel: 'Dual Garmin G3X Touch, GTN 650Xi, GFC 500 autopilot',
      hangar: 'Hangar 12, South Albany (4B0)',
      visibility: 'public',
      featured: 1,
      summary:
        'Quick-build kit started in 2023. Wings closed, fuselage on the gear, currently deep in the wiring and the associated existential questions.',
      bodyMd: `I ordered the tail kit in a fit of enthusiasm three winters ago and have been quietly consumed by it ever since.

## Why an RV-7A

I wanted something I could actually use — two seats, a decent cross-country cruise, and a build that has been done enough times that when I get stuck at eleven at night there is somebody on a forum who got stuck in exactly the same place in 2009.

## What I have changed from stock

- Andair fuel valve instead of the stock selector
- Aileron trim, because I fly with a heavy passenger and a light one
- Extra inspection panel in the left wing bottom skin, because future-me will want it

## What I am dreading

The canopy. Everybody says the canopy. I have read the forums, I have watched the videos, and I am still going to put it off until spring.`,
      updates: [
        {
          title: 'Tail kit arrived. Counted everything twice.',
          days: 1175,
          hours: 4,
          body: `Crate landed on the driveway at 7am and the courier would not help me move it, which is fair enough.

Spent the day inventorying. Everything present except one AN470AD4-5 bag, which Van's shipped without argument two days later.

Lesson one of building: the inventory is not optional. Lesson two: buy more shelving than you think you need, then buy more.`,
        },
        {
          title: 'Empennage done. It looks like an aeroplane part.',
          days: 980,
          hours: 118,
          body: `Vertical stabiliser, horizontal stabiliser, elevators and rudder all complete and hanging on the garage wall.

The trailing edges took three attempts. The first one bowed, the second one I drilled slightly off, and the third came out straight enough that I have stopped looking at it too closely.

**What I would tell somebody starting today:** buy the tank sealant scale. Weighing proseal instead of eyeballing it is the difference between a job and an ordeal.`,
        },
        {
          title: 'Both wings closed. Left tank passed the balloon test.',
          days: 520,
          hours: 340,
          body: `Wings are closed and off the stands.

The tanks are the part nobody enjoys. I did them one at a time over six weekends, and the left one held pressure overnight with the balloon barely deflating. The right one leaked at a rib rivet, which meant going back in through the access plate with a syringe and quite a lot of swearing.

Dave came over as Technical Counselor and went through the whole thing with a torch and a mirror. He found two rivets I had not set properly in the rear spar and one place where I had run a wire without a grommet. Both fixed. **Get the visit. It is free and it is worth ten times what it costs you in coffee.**`,
        },
        {
          title: 'Fuselage on the gear. Wiring has begun.',
          days: 96,
          hours: 208,
          body: `She is on her own wheels, which changes everything psychologically. It went from a pile of parts to an aeroplane in about forty minutes.

Now the wiring. I have the panel laid out in CAD, I have a labelled wire list, and I have already changed my mind twice about where the ELT goes.

Borrowed Tom's DMC crimp set from the chapter Tool Locker. The difference between that and the cheap crimper I had been using is not subtle — every pin seats properly and the pull test is boring, which is exactly what you want from a pull test.

Next up: firewall forward, and then, eventually, the canopy I keep pretending is not coming.`,
        },
      ],
    },
    {
      owner: 'ken',
      title: 'Waiex-B, slowly',
      aircraftType: 'Sonex Waiex-B',
      tailNumber: null,
      buildKind: 'kit',
      status: 'building',
      percentComplete: 38,
      startedOn: daysAgo(1490),
      engine: 'AeroVee 2.1 (turbo delete, for now)',
      panel: 'MGL iEFIS Lite, steam ASI as backup',
      hangar: 'Two-car garage, Delmar NY',
      visibility: 'public',
      summary:
        'Four years, one garage, two children, one full-time job. Progress is real but it is measured in evenings, not weekends.',
      bodyMd: `This is a slow build and I have made peace with that.

I get maybe five hours a week, sometimes none. What I have learned is that showing up for forty minutes and deburring six parts still counts. The builds that die are the ones where somebody waits for a free Saturday that never comes.

The Y-tail is the reason I picked the Waiex. It is not faster or better. It just looks like that, and that turned out to be reason enough.`,
      updates: [
        {
          title: 'Year one: tail feathers and a lot of deburring',
          days: 1120,
          hours: 210,
          body: `Ruddervators done. The Y-tail parts are small and fiddly and there are more of them than you expect.

If I could go back I would buy the Scotch-Brite wheel on day one instead of month eight. The amount of time I spent deburring by hand is genuinely embarrassing.`,
        },
        {
          title: 'Wing spars complete. Garage now officially too small.',
          days: 610,
          hours: 265,
          body: `Both spars built up and inspected. They are 22 feet of aluminium in a 20-foot garage, which required some creative thinking and the temporary relocation of a car.

My wife has been extremely good about this. I have promised her the first ride, which I suspect she is regretting agreeing to.`,
        },
        {
          title: 'Tailcone riveted. Borrowed the good rivet gun.',
          days: 8,
          hours: 44,
          body: `Marta lent me the 3X and the tungsten bucking bars through the chapter Tool Locker, and it made the aft bulkhead rivets possible in a way my 2X simply did not.

That is the whole argument for the Tool Locker in one paragraph. I was not going to buy a $300 gun and a set of tungsten bars to do about ninety rivets. Now those ninety rivets are done, properly, and the gun goes back to Marta this week.`,
        },
      ],
    },
    {
      owner: 'dave',
      title: 'Champ NC81234 — eleven winters',
      aircraftType: '1946 Aeronca 7AC Champion',
      tailNumber: 'NC81234',
      buildKind: 'restoration',
      status: 'flying',
      percentComplete: 100,
      startedOn: daysAgo(4400),
      firstFlightOn: daysAgo(330),
      engine: 'Continental A-65-8, overhauled 2024',
      panel: 'Original, plus a handheld and a transponder hidden where you cannot see it',
      hangar: 'Hangar 3, South Albany (4B0)',
      visibility: 'public',
      featured: 1,
      summary:
        'A 1946 Champ that arrived in three trailer loads and a lot of boxes, and flew again in 2025. Fabric, wood, steel and patience.',
      bodyMd: `I bought this aeroplane in pieces from a widow in Vermont who wanted it to fly again rather than be sold for parts. That promise is the only reason I finished it.

## What it needed

Everything. New fabric, new wood in both wings, the fuselage tubing sandblasted and about fourteen inches of it replaced, the A-65 overhauled, and a fuel tank that was more rust than tank.

## What it taught me

Old aeroplanes are simple but they are not easy. Every job reveals a job underneath it. The trick is to write down what you find and fix it in order, rather than chasing whichever problem is most annoying that day.

It flies beautifully. It cruises at 75 mph if the wind is kind, and there is nowhere I would rather be at seven on a summer evening.`,
      updates: [
        {
          title: 'Fuselage back from sandblasting. The truth revealed.',
          days: 2100,
          hours: 90,
          body: `Stripped, blasted, and considerably more honest than it was when I bought it.

Fourteen inches of lower longeron on the left side had to come out — you could put a screwdriver through it. Welded in new 4130 with a proper internal sleeve, then treated the inside of every tube with linseed oil and plugged them.

That is the job that nearly ended this project. It is also the job that made everything after it feel manageable.`,
        },
        {
          title: 'Covered, taped, and silver. Three coats of pride.',
          days: 900,
          hours: 320,
          body: `Both wings and the fuselage covered in Poly-Fiber and up to silver.

Covering is not hard. Covering *well* is hard, and it is entirely about preparation and patience. Every dust speck you leave on the surface is a dust speck you will see forever.

The chapter's covering iron set and pinking shears did this whole aeroplane. They are still in my hangar and anybody who wants them should ask.`,
        },
        {
          title: 'First flight. Everything worked. I cried a bit.',
          days: 330,
          hours: 2,
          body: `Bill flew the first flight — I have maybe 40 hours in type and he has thousands, and my Flight Advisor was very clear that this was not the day to be sentimental about who is in the seat.

Twenty-five minutes in the pattern and over the river. Oil temperature and pressure both dead centre. Wings level hands-off. He landed it, taxied back, shut down, got out and said "that is a nice aeroplane, Dave."

Eleven winters. Worth every one.`,
        },
      ],
    },
    {
      owner: 'tom',
      title: '750 for the back forty',
      aircraftType: 'Zenith CH 750 Cruzer',
      tailNumber: 'N750TV',
      buildKind: 'kit',
      status: 'painting',
      percentComplete: 88,
      startedOn: daysAgo(900),
      engine: 'Rotax 912ULS',
      panel: 'Dynon SkyView HDX, single screen',
      hangar: 'Hangar 6, South Albany (4B0)',
      visibility: 'public',
      summary:
        'Match-hole kit, built mostly at the field. Airframe done, engine hung, currently arguing with myself about paint schemes.',
      bodyMd: `I retired, and about four days later realised I needed a project or I was going to reorganise the garage for the rest of my life.

The 750 Cruzer suits what I want to do: get in and out of short grass, carry two people and some camping gear, and go slowly enough to look at things.

The match-hole kit is genuinely as good as everybody says. If you can read a drawing and clean a part, you can build one of these.`,
      updates: [
        {
          title: 'Engine hung. Rotax is smaller than I expected.',
          days: 150,
          hours: 60,
          body: `912ULS on the mount with Bill's engine hoist from the Tool Locker, which lifted it without noticing.

The whole engine weighs less than the toolbox I used to carry up poles for a living. Everything about it feels precise in a way the old Continentals do not, for better and worse — it wants coolant, it wants a proper radiator install, and it does not forgive guesswork.`,
        },
        {
          title: 'Paint scheme: eleven printouts, one decision',
          days: 21,
          hours: 12,
          body: `Airframe is done. Every inspection panel opens, every control moves the right way, and the weight and balance is signed off.

Which leaves paint. I have printed eleven schemes and taped them to the hangar wall. The chapter has voted, unhelpfully, for eleven different ones.

Current favourite is a cream fuselage with a dark green sweep, which Dave says will look like a 1950s bread van. Dave is not necessarily wrong.`,
        },
      ],
    },
    {
      owner: 'sue',
      title: '170B panel refresh',
      aircraftType: 'Cessna 170B',
      tailNumber: null,
      buildKind: 'maintenance',
      status: 'building',
      percentComplete: 45,
      startedOn: daysAgo(120),
      engine: 'Continental O-300-D',
      panel: 'Going from six-pack to Garmin G5 pair plus GNC 355',
      hangar: 'Hangar 1, South Albany (4B0)',
      // Deliberately members-only, to show the visibility control working.
      visibility: 'members',
      summary:
        'Panel modernisation on the 170. Members-only because I would rather not advertise what is sitting in an unlocked hangar.',
      bodyMd: `Nothing exotic — pulling the old vacuum system out, putting a pair of G5s and a GNC 355 in, and tidying forty years of accumulated wiring while I am in there.

Keeping this one members-only. Not because it is secret, but because "hangar 1 currently contains several thousand dollars of new avionics" is not a sentence I want indexed by a search engine.`,
      updates: [
        {
          title: 'Vacuum system out. So much empty space.',
          days: 60,
          hours: 22,
          body: `Pump, lines, filter and both gyros gone. The back of the panel looks enormous now.

Found a wire bundle behind the radio stack that had been repaired with what I can only describe as household electrical tape, at some point in probably the 1980s. Replaced properly with Tefzel and the DMC crimper from the Tool Locker.

This is the real reason to do your own panel work: you find out what is actually in there.`,
        },
      ],
    },
  ];

  for (const b of buildSeed) {
    const cover = await art('scene', `${b.title}-cover`);
    const buildId = Builds.saveBuild({
      ownerId: users[b.owner].id,
      title: b.title,
      aircraftType: b.aircraftType,
      tailNumber: b.tailNumber,
      buildKind: b.buildKind,
      status: b.status,
      percentComplete: b.percentComplete,
      startedOn: b.startedOn,
      firstFlightOn: b.firstFlightOn ?? null,
      engine: b.engine,
      panel: b.panel,
      hangar: b.hangar,
      summary: b.summary,
      bodyMd: b.bodyMd,
      coverPath: cover.fullPath,
      coverAlt: `${b.aircraftType} project`,
      externalLogUrl: null,
      visibility: b.visibility,
    });
    if (b.featured) Builds.setFeatured(buildId, true);

    for (const u of b.updates) {
      const updateId = Builds.saveUpdate(buildId, {
        authorId: users[b.owner].id,
        title: u.title,
        bodyMd: u.body,
        hours: u.hours,
        status: 'published',
        postedAt: daysAgo(u.days, 19, 30),
      });
      const shots = u.days < 400 ? 3 : 2;
      for (let i = 0; i < shots; i += 1) {
        const img = await art('scene', `${b.title}-${u.days}-${i}`);
        // No caption: the generated art has nothing meaningful to describe,
        // and repeating the entry title under it just reads as a duplicate.
        Builds.addUpdatePhoto(updateId, {
          fullPath: img.fullPath,
          thumbPath: img.thumbPath,
          caption: null,
        });
      }
    }

    // A few cheers so the counter is not stuck at zero.
    for (const key of ['dave', 'bill', 'sue', 'nora']) {
      if (key !== b.owner) Builds.toggleCheer(buildId, users[key].id);
    }
  }
  console.log(`[seed] ${buildSeed.length} build logs`);

  /* ------------------------------------------------------------- events */

  const poster = await realPoster();

  const eventSeed = [
    {
      title: 'Spring Cleanup and Shop Day',
      kind: 'workshop',
      days: -124,
      hour: 9,
      endHour: 15,
      summary: 'Rake, sweep, fix the windsock, and get the clubhouse ready for breakfast season.',
      bodyMd:
        'Annual tidy-up before the flying season. Bring gloves and a rake. We provide coffee, doughnuts and an unreasonable amount of enthusiasm about mowing.',
      recapMd:
        'Nineteen people turned out, which is more than we expected on a cold Saturday. The windsock is new, the clubhouse gutters are clear, and the north tie-down area is usable again. Thanks especially to whoever brought the second chainsaw.',
      attendance: 19,
      cost: 'Free',
    },
    {
      // The real one. Details from the chapter's public AOPA listing.
      title: 'Pancake Breakfast Fly-In',
      kind: 'fly-in',
      days: -75,
      hour: 9,
      endHour: 12,
      summary:
        'Come see airplanes up close, find out about a local airport, and learn how you can begin building your very own airplane or get involved in flying.',
      bodyMd: `Attendance is free; food has a fee.

Come see airplanes up close, find out about a local airport, and learn about how you can begin building your very own airplane or get involved in flying.

Fly in or drive in — both are equally welcome. There is parking on the field for aircraft and plenty of room for cars.`,
      recapMd:
        'Best turnout we have had. Fourteen aircraft flew in despite a marginal forecast that cleared beautifully by nine, and we served pancakes until the batter ran out at about half past eleven. Nora talked three different families through her Ray Scholarship story, which is exactly what these mornings are for.',
      attendance: 210,
      cost: '$10',
      rainDays: -74,
      // The real listing names a chapter member and gives his personal email
      // and mobile. Demo data should not carry a real person's contact
      // details around, so this is a chapter-level placeholder. Put the real
      // ones back (with that member's agreement) when the site goes live.
      contactName: 'Chapter events team',
      contactEmail: 'events@eaa1699.org',
      contactPhone: null,
      externalUrl: 'https://www.aopa.org/destinations/event/1817',
      posterPath: poster.fullPath,
      posterAlt:
        'Cartoon of a yellow and blue taildragger flying low over green fields while families wave from a pancake breakfast tent beside a red barn marked South Albany Airport 4B0',
    },
    {
      title: 'Young Eagles Rally',
      kind: 'young-eagles',
      days: -61,
      hour: 9,
      endHour: 13,
      summary: 'Free first flights for kids aged 8 to 17, flown by volunteer chapter pilots.',
      bodyMd:
        'Registration opens at 9am. Bring a parent or guardian — they will need to sign the consent form, and they usually want to watch anyway.\n\nEvery pilot is a chapter volunteer, every aircraft is inspected, and every kid gets a logbook entry and a certificate signed by the pilot who flew them.',
      recapMd:
        '38 kids flown between nine and one. Six pilots, four aircraft, and a ground crew who did not stop moving. Two of the kids have already asked about coming to a meeting.',
      attendance: 95,
      cost: 'Free',
    },
    {
      title: 'Chapter Summer Picnic',
      kind: 'social',
      days: -26,
      hour: 16,
      endHour: 21,
      summary: 'Burgers, hangar flying, and somebody always brings a guitar.',
      bodyMd: 'Family event. Bring a side dish and a chair. The grill goes on at four.',
      recapMd:
        'Perfect evening. Marta towed the RV fuselage out of the hangar so people could look at it, and it drew a crowd for two hours. Tom brought his eleven paint scheme printouts and canvassed everybody. The vote remains inconclusive.',
      attendance: 64,
      cost: 'Bring a dish',
    },
    {
      title: 'August Chapter Meeting',
      kind: 'meeting',
      days: 7,
      hour: 19,
      endHour: 21,
      summary: 'Monthly meeting: members’ projects, Ray Scholarship update, and fall event planning.',
      bodyMd:
        'Everybody welcome, members and visitors alike. Doors at half six, meeting at seven.\n\n**On the agenda:** Nora reports on her training progress, Tom presents the paint scheme problem to the assembled experts, and we need volunteers for the September breakfast.',
      cost: 'Free',
    },
    {
      title: 'Young Eagles Rally',
      kind: 'young-eagles',
      days: 30,
      hour: 9,
      endHour: 13,
      summary: 'Free first flights for kids aged 8 to 17. Registration opens at 9am.',
      bodyMd:
        'Our last rally of the year. Bring a parent or guardian to sign the consent form.\n\nIf you are a chapter pilot willing to fly, please let Sue know — we can always use another aircraft, and the queue moves much faster with five than with four.',
      cost: 'Free',
      contactName: 'Sue Delaney',
    },
    {
      title: 'Fall Fly-In Breakfast',
      kind: 'fly-in',
      days: 44,
      hour: 8,
      endHour: 12,
      summary: 'Pancakes, sausage, coffee and airplanes. Fly in or drive in — both welcome.',
      bodyMd:
        'Our end-of-season breakfast, and traditionally the best-attended one, because the air is cool and the leaves are turning and everybody wants an excuse to fly.\n\nAttendance is free; breakfast is $10. Kids under 10 eat free.\n\nVolunteers will direct you to aircraft parking once you are clear of the runway. Car parking is signposted — follow the signs and the person waving.',
      cost: '$10',
      rainDays: 45,
      contactName: 'Chapter events team',
      contactEmail: 'events@eaa1699.org',
      posterPath: poster.fullPath,
      posterAlt:
        'Cartoon of a yellow and blue taildragger flying over green fields beside a pancake breakfast tent at South Albany Airport',
    },
    {
      title: 'VMC Club Night',
      kind: 'meeting',
      days: 56,
      hour: 19,
      endHour: 21,
      summary: 'Scenario-based visual flying discussion. Everybody votes, then everybody argues.',
      bodyMd:
        'VMC Club works through real visual-flying scenarios as a group — the decisions that quietly get people into trouble.\n\nNo experience level required. Student pilots often ask the best questions, because they have not yet learned which questions you are supposedly meant to already know the answer to.',
      cost: 'Free',
    },
    {
      title: 'Chapter Holiday Dinner',
      kind: 'social',
      days: 114,
      hour: 18,
      endHour: 22,
      summary: 'Annual dinner, awards, and the year in photographs.',
      bodyMd:
        'Partners and families very welcome. We hand out the Builder of the Year award, show far too many photographs, and somebody makes a speech that runs long.\n\nRSVP by the start of December so we can give the venue a number.',
      cost: '$35 per person',
    },
  ];

  for (const e of eventSeed) {
    const startsAt = e.days < 0 ? daysAgo(-e.days, e.hour) : daysAhead(e.days, e.hour);
    const endsAt = e.days < 0 ? daysAgo(-e.days, e.endHour) : daysAhead(e.days, e.endHour);

    const eventId = Events.saveEvent({
      title: e.title,
      summary: e.summary,
      bodyMd: e.bodyMd,
      startsAt,
      endsAt,
      allDay: 0,
      rainDate: e.rainDays == null ? null : e.rainDays < 0 ? daysAgo(-e.rainDays, 9) : daysAhead(e.rainDays, 9),
      locationName: `${config.site.airport.name} (${config.site.airport.ident})`,
      address: config.site.airport.street,
      city: config.site.airport.city,
      state: config.site.airport.state,
      zip: config.site.airport.zip,
      latitude: config.site.airport.latitude,
      longitude: config.site.airport.longitude,
      cost: e.cost ?? null,
      contactName: e.contactName ?? null,
      contactEmail: e.contactEmail ?? null,
      contactPhone: e.contactPhone ?? null,
      externalUrl: e.externalUrl ?? null,
      posterPath: e.posterPath ?? null,
      posterAlt: e.posterAlt ?? null,
      kind: e.kind,
      status: 'published',
      recapMd: e.recapMd ?? null,
      attendance: e.attendance ?? null,
    });

    // Past events get a photo gallery.
    if (e.days < 0) {
      for (let i = 0; i < 4; i += 1) {
        const img = await art('scene', `${e.title}-${i}`);
        Events.addPhoto(eventId, {
          fullPath: img.fullPath,
          thumbPath: img.thumbPath,
          caption: null,
        });
      }
    }
  }
  console.log(`[seed] ${eventSeed.length} events`);

  /* --------------------------------------------------------------- blog */

  const postSeed = [
    {
      author: 'marta',
      title: 'What a Technical Counselor visit actually looks like',
      days: 12,
      visibility: 'public',
      tags: ['building', 'safety', 'tech-counselor'],
      summary:
        'Dave spent three hours going over my wings with a torch and a mirror. Here is what he found, and why you should book one.',
      body: `I put this off for two years because I was quietly afraid of what somebody would find. That was exactly backwards.

## What actually happened

Dave turned up on a Saturday morning with a torch, an inspection mirror, and a notebook. He spent about three hours on the wings and another hour on the fuselage. He did not touch anything without asking. He did not once make me feel stupid.

## What he found

- **Two rivets in the rear spar** that had not set properly. I had looked at them and told myself they were fine. They were not fine. Drilled out and replaced in twenty minutes.
- **A wire run through a rib without a grommet.** It had not chafed yet. Give it four hundred hours of vibration and it absolutely would have.
- **My tank access plate screws** were a mix of two different lengths, which meant three of them were not fully engaged.

None of that is dramatic. That is the point. None of it was going to bring an aeroplane down next Tuesday, and all of it was going to become somebody's problem eventually.

## Why you should book one

It is free. Your chapter has counsellors. EAA's own numbers show builders who use Technical Counselors have a measurably better safety record, and having now had a visit I understand exactly why: it is not that the counsellor catches catastrophes, it is that they catch the twenty small things you have stopped being able to see.

Talk to Dave. Or talk to me and I will introduce you.`,
    },
    {
      author: 'sue',
      title: '38 kids, six pilots, one very good Saturday',
      days: 58,
      visibility: 'public',
      tags: ['young-eagles', 'events'],
      summary:
        'June’s Young Eagles rally in numbers, and the one conversation that made the whole day.',
      body: `Thirty-eight kids flown between nine and one. Six pilots, four aircraft, and a ground crew who did not sit down once.

Some numbers, because people always ask:

| | |
|---|---|
| Kids flown | 38 |
| Pilots | 6 |
| Aircraft | 4 |
| Average flight | 17 minutes |
| Doughnuts consumed | classified |

But the number that matters is one. One girl, about eleven, who got out of Bill's Cub and asked her mother — completely seriously — what she would have to do to be allowed to fly one every day.

Her mother looked at me. I said "well, that is a longer conversation, and we have a chapter meeting on the third Wednesday."

That is the whole programme. Not the thirty-eight. The one.

**Next rally is in September.** If you have an aeroplane and a pilot certificate, we would love another one on the line.`,
    },
    {
      author: 'dave',
      title: 'The Tool Locker is open',
      days: 96,
      visibility: 'members',
      tags: ['tool-locker', 'chapter'],
      summary:
        'Ten tools listed, six members lending. Here is how it works and what we ask of you.',
      body: `We have wanted a chapter tool library for years. The problem was always administration — who has what, who had it last, and who to shout at when it comes back broken.

The website now handles all of that.

## How it works

1. **List what you are willing to lend.** Photos, where it lives, and your own terms. You set the rules for your own tools; the chapter does not.
2. **Somebody asks.** You get an email. You approve or decline. Your email address is never shown to them, and theirs is not shown to you until you say yes.
3. **The tool shows as on loan** until you mark it returned.

## What we ask

- Return it clean, and on time, or tell somebody you need it longer.
- If you break it, say so. **Everybody breaks things.** What corrodes a chapter is people quietly returning damaged tools.
- Do not lend a borrowed tool on to a third person. Send them to the owner.
- Say thank you.

That is it. Ten tools are listed already, including Marta's rivet squeezer, Bill's engine hoist and my covering irons. Add yours.`,
    },
    {
      author: 'gary',
      title: 'August meeting notes',
      days: 3,
      visibility: 'members',
      tags: ['meeting-notes'],
      summary:
        'Ray Scholarship update, September breakfast volunteers needed, and the paint scheme situation.',
      body: `Twenty-two present, three visitors.

## Ray Aviation Scholarship

Nora reported on her training. She soloed in March, has the written passed, and is working towards the checkride this autumn. The chapter agreed to cover her checkride fee out of the events fund — proposed by Bill, seconded by Sue, carried unanimously.

## September breakfast

**We need volunteers.** Specifically:

- Two people on the griddle from 6:30am
- Two on aircraft parking
- Somebody to take the money who is good with a float

Sign-up sheet is in the clubhouse and Marta will chase you if you do not use it.

## Members' projects

- Marta: fuselage on the gear, wiring underway
- Ken: tailcone riveted, borrowed the 3X and reports it made all the difference
- Tom: airframe complete, paint scheme unresolved
- Sue: 170 panel about half done, vacuum system out

## Any other business

Tom presented eleven paint schemes. The chapter voted. The chapter produced eleven different answers. Tabled to September.

Next meeting: third Wednesday, 7pm.`,
    },
    {
      author: 'bill',
      title: 'Compression testing: what the number actually means',
      days: 34,
      visibility: 'public',
      tags: ['maintenance', 'engines'],
      summary:
        'A differential compression reading is not a grade. It is one data point, and it lies more often than people think.',
      body: `Somebody rang me last week worried sick because a shop told him he had "a 62 on number three".

Here is what I told him.

## The test is differential, not absolute

You are putting a known pressure in and measuring what leaks out past a calibrated orifice. That means the reading depends on:

- **Engine temperature.** A cold engine reads low. Fly it, then test it.
- **Prop position.** If the piston is not at the top of the stroke the rings are not seated where they will be running.
- **How long you wait.** Rings settle. The first reading and the reading thirty seconds later can differ by five points.

## Where is it leaking?

This matters far more than the number:

- **Hissing from the exhaust** — exhaust valve. Take this seriously.
- **Hissing from the intake** — intake valve. Also serious.
- **Bubbling in the oil filler** — rings. Often fine, especially on a low-time or recently overhauled cylinder.

A 62 that is leaking past the rings on a warm engine that makes full power and does not use oil is a completely different animal from a 62 hissing out of the exhaust.

## What to do

Do not pull a cylinder on one reading. Fly it, test it again warm, and look at the trend. Trends tell you things. Single numbers mostly tell you about the day you took them.

The chapter has a proper differential tester with a master orifice in the Tool Locker. Ask and I will come and run it with you.`,
    },
    {
      author: 'marta',
      title: 'Newsletter is going out by email again',
      days: 140,
      visibility: 'members',
      tags: ['chapter'],
      summary: 'Short one: the newsletter is back, and here is what goes in it.',
      body: `The newsletter lapsed for about eight months, which was my fault and nobody else's.

It is back, monthly, on the first Sunday. It will contain:

- What happened at the meeting, for the people who could not come
- What is coming up
- One members' project, in detail
- One safety item, usually something that nearly happened to one of us

If you want your project featured, tell me. If you had a moment in the air that taught you something, tell me that too — anonymously if you would rather. Those are the most-read items every single time, because everybody has had one and almost nobody talks about it.`,
    },
  ];

  for (const p of postSeed) {
    const cover = await art('scene', `post-${p.title}`);
    Posts.createPost({
      title: p.title,
      summary: p.summary,
      bodyMd: p.body,
      authorId: users[p.author].id,
      status: 'published',
      visibility: p.visibility,
      tags: p.tags,
      coverPath: cover.fullPath,
      coverAlt: p.title,
      pinned: p.days <= 3 ? 1 : 0,
    });
  }

  // Back-date the posts so the blog does not look like it appeared all at once.
  for (const p of postSeed) {
    const when = daysAgo(p.days, 20, 0);
    run('UPDATE posts SET created_at = ?, updated_at = ?, published_at = ? WHERE title = ?', [
      when,
      when,
      when,
      p.title,
    ]);
  }

  // A couple of comments on the counsellor post.
  const counsellorPost = get('SELECT id FROM posts WHERE title LIKE ?', [
    'What a Technical Counselor%',
  ]);
  if (counsellorPost) {
    Posts.addComment(
      counsellorPost.id,
      users.ken.id,
      'This is the push I needed. Booked Dave for the weekend after next. The wings are closed but the fuselage is very much open.'
    );
    Posts.addComment(
      counsellorPost.id,
      users.dave.id,
      'Happy to come out Ken. Bring good light and clear a path round the whole thing — I need to get at both sides.'
    );
  }
  console.log(`[seed] ${postSeed.length} blog posts`);

  /* --------------------------------------------------- contact messages */

  const messages = [
    {
      name: 'Priya Raman',
      email: 'priya.raman@example.com',
      topic: 'Young Eagles flight',
      message:
        'My daughter is 12 and has decided she is going to be a pilot. She has decided this very firmly. When is your next Young Eagles day and what do we need to bring?',
      days: 1,
    },
    {
      name: 'Frank Delacroix',
      email: 'frank.d@example.com',
      topic: 'Visiting / fly-in',
      message:
        'Planning to fly in from Massachusetts for the fall breakfast in the Cherokee. Is there transient parking for a Cherokee, and is self-serve fuel available on a Sunday morning? First time in.',
      days: 4,
    },
    {
      name: 'Marcus Oyelaran',
      email: 'm.oyelaran@example.com',
      topic: 'Building help',
      message:
        'I have a partly built Kitfox that I bought from an estate sale and honestly I have no idea whether what I have is any good. Is there someone in the chapter who could look at it and tell me the truth? I am about 40 minutes from the field.',
      days: 9,
    },
  ];

  for (const m of messages) {
    run(
      `INSERT INTO contact_messages (name, email, topic, message, created_at, handled_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [m.name, m.email, m.topic, m.message, daysAgo(m.days, 21, 10), m.days > 7 ? daysAgo(m.days - 1) : null]
    );
  }
  console.log(`[seed] ${messages.length} contact messages`);

  /* ------------------------------------------- membership applications */

  const applications = [
    {
      firstName: 'Marcus',
      lastName: 'Oyelaran',
      email: 'm.oyelaran@example.com',
      phone: '5185550142',
      aircraft: 'Part-built Kitfox IV (inherited, condition unknown)',
      homeBase: 'Barn in Coeymans',
      interest: 'I am building or restoring an aircraft',
      message:
        'I bought a partly built Kitfox from an estate sale and I genuinely do not know whether what I have is any good. I came to the May breakfast and Bill spent twenty minutes talking me through what to look for, which is more help than I have had in a year of internet forums. I would like to join properly and get a Technical Counselor to look at it.',
      days: 6,
    },
    {
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya.raman@example.com',
      phone: '5185550118',
      homeBase: 'Delmar',
      interest: 'I am a Young Eagles parent',
      message:
        'My daughter flew with Sue at the June rally and has talked about almost nothing else since. She is 12. I would like to keep up with what the chapter is doing and bring her to the meetings if that is allowed. I am not a pilot and know nothing about aeroplanes, which I hope is not disqualifying.',
      days: 3,
    },
    {
      firstName: 'Frank',
      lastName: 'Delacroix',
      email: 'frank.d@example.com',
      aircraft: 'Piper Cherokee 180',
      homeBase: 'Pittsfield (PSF)',
      interest: 'I fly and want to meet local pilots',
      message:
        'Flew in for the breakfast in May from Massachusetts and had a much better morning than I expected. I am about an hour out but I would like to be involved — happy to fly Young Eagles once I have done the paperwork.',
      days: 1,
    },
  ];

  for (const a of applications) {
    const id = Applications.createApplication({
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      phone: a.phone ?? null,
      eaaNumber: null,
      aircraft: a.aircraft ?? null,
      homeBase: a.homeBase ?? null,
      interest: a.interest,
      message: a.message,
      ipHash: null,
      userAgent: null,
    });
    if (id) {
      run('UPDATE membership_applications SET created_at = ? WHERE id = ?', [
        daysAgo(a.days, 21, 40),
        id,
      ]);
    }
  }
  console.log(`[seed] ${applications.length} membership requests awaiting review`);

  /* ------------------------------------------------- admin access link */

  const admin = Users.findByEmail(ADMIN_EMAIL);
  const token = Users.createPasswordResetToken(admin.id);
  const link = absoluteUrl('/invite-bootstrap');

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' Demo content is in place.');
  console.log('');
  console.log(` Admin account: ${admin.email}  (role: ${admin.role})`);
  console.log('');
  console.log(' No password was set for it — the site never stores one and no');
  console.log(' script here can create one. Set yours with this single-use link:');
  console.log('');
  console.log(`   ${absoluteUrl(`/reset/${token}`)}`);
  console.log('');
  console.log(` It expires in ${config.auth.resetTokenTtlMinutes} minutes. Run \`npm run seed\` again`);
  console.log(' (or use Forgot password) to generate a fresh one.');
  console.log('──────────────────────────────────────────────────────────────\n');
  void link;
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
