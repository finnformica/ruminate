/**
 * THROWAWAY EXPERIMENT FIXTURE — not shipped, not imported by src/ or worker/.
 *
 * A stand-in corpus for `scripts/chunking-experiment.ts`, shaped like the
 * OWNER's real one rather than like a document store: production holds 634
 * blocks / 25,847 characters, longest block 175 characters, mean ~41 (about
 * eight words). Everything below is invented — production data is never
 * embedded by this experiment (docs/mcp-search.md) — but the shape is copied,
 * because the shape is the whole question: can an eight-word fragment be
 * retrieved by a query that does not share its words?
 *
 * Twenty notes across the domains a personal outliner actually accumulates,
 * each a few headings with short bullets under them. The distractor density
 * matters as much as the targets: a 60-block toy corpus makes any retriever
 * look good, so this one is deliberately near the real block count.
 */

export interface FixtureBlock {
  id: string
  type: "h2" | "h3" | "ul" | "text" | "todo" | "done" | "quote" | "code"
  text: string
  children?: FixtureBlock[]
}

export interface FixtureNote {
  id: string
  title: string
  blocks: FixtureBlock[]
}

/** A heading with its bullets — the shape every note below is built from. */
const section = (id: string, heading: string, lines: string[]): FixtureBlock => ({
  id: `${id}_h`,
  type: "h2",
  text: heading,
  children: lines.map((line, index) => ({
    id: `${id}_${index}`,
    type: line.startsWith("[ ] ")
      ? ("todo" as const)
      : line.startsWith("[x] ")
        ? ("done" as const)
        : ("ul" as const),
    text: line.replace(/^\[[ x]\] /, ""),
  })),
})

export const FIXTURE_NOTES: FixtureNote[] = [
  {
    id: "note_ruminate",
    title: "Ruminate",
    blocks: [
      section("rum_sync", "Sync", [
        "Row diffs push through the Worker, never whole notes",
        "Last writer wins per row, on updated_at",
        "The overlap window was costing 499k reads a day",
        "seq is assigned server side inside the write batch",
        "A cursor is an integer both sides agree on",
        "[x] Drop the ten minute overlap on pulls",
        "Tombstones travel like any other change",
      ]),
      section("rum_editor", "Editor", [
        "Every edit is a batch of ops, persisted verbatim",
        "docToOps diffs the edited doc against the snapshot",
        "Folding state is per view, not stored in the graph",
        "Block types are declared once in the registry",
        "The marker column holds the dot, hash or checkbox",
        "[ ] Make the collapse chevron keyboard reachable",
      ]),
      section("rum_cost", "Cost", [
        "D1 free tier is five million row reads a day",
        "One ambient browser event ate 97 percent of it",
        "Targeted loaders bound a read by the question asked",
        "A leaf read went from 1620 rows to four",
        "Writes still load everything, and should",
      ]),
      section("rum_ideas", "Ideas", [
        "A block should be able to live in two notes at once",
        "Zoom into a block and it becomes the page title",
        "Unassigned blocks hang under the outline, not lost",
        "[ ] Weekly notes that roll up the dailies beneath them",
      ]),
    ],
  },
  {
    id: "note_network",
    title: "Home network",
    blocks: [
      section("net_kit", "Kit", [
        "Unifi gateway in the cupboard under the stairs",
        "Two access points, one upstairs one in the kitchen",
        "The switch is passively cooled and silent",
        "Cat6 run to the office, stapled along the skirting",
      ]),
      section("net_dns", "DNS", [
        "Pi-hole answers on the .lan domain",
        "Upstream resolver is Cloudflare over TLS",
        "Ad blocking broke the supermarket app once",
        "Keep a second resolver or the house goes dark",
        "[ ] Move the pi-hole off the SD card, it will die",
      ]),
      section("net_wifi", "Wireless", [
        "Channel 6 is a swamp, everything sits on it",
        "Band steering off, the printer cannot cope",
        "Guest network is isolated from everything else",
        "The smart bulbs only speak 2.4GHz",
      ]),
      section("net_trouble", "Troubleshooting", [
        "When the video calls stutter it is the uplink",
        "Speed test to a nearby server, not a far one",
        "Reboot the modem before blaming the router",
      ]),
    ],
  },
  {
    id: "note_sourdough",
    title: "Sourdough",
    blocks: [
      section("dough_starter", "Starter", [
        "Feed 1:5:5 the night before if the kitchen is cold",
        "It should double and smell of yoghurt, not acetone",
        "A starter kept in the fridge needs two days to wake",
        "Discard makes decent pancakes",
      ]),
      section("dough_mix", "Mixing", [
        "78 percent hydration is the ceiling for this flour",
        "Autolyse an hour before the salt goes in",
        "Slap and fold until the dough stops tearing",
        "Four sets of coil folds, forty minutes apart",
      ]),
      section("dough_bake", "Bake", [
        "Cold retard overnight gives the open crumb",
        "Bake covered at 250 for twenty minutes",
        "Uncovered at 220 until the crust is very dark",
        "Do not cut it hot, the crumb goes gummy",
        "[ ] Try a longer bulk at a lower temperature",
      ]),
    ],
  },
  {
    id: "note_reading",
    title: "Reading list",
    blocks: [
      section("read_now", "Reading now", [
        "Seeing Like a State, slow but the thesis lands early",
        "High output management, mostly still true",
        "A short history of nearly everything, again",
      ]),
      section("read_queue", "Queue", [
        "Thinking in systems, borrowed from Dan",
        "The Making of the Atomic Bomb, enormous",
        "Piranesi, everyone says finish it in one sitting",
        "Against Method, apparently annoying on purpose",
      ]),
      section("read_notes", "Notes", [
        "Legibility destroys the local knowledge it measures",
        "A metric that becomes a target stops measuring",
        "The map is not the territory but it is what we steer by",
        "Complex systems fail in ways nobody modelled",
      ]),
    ],
  },
  {
    id: "note_running",
    title: "Marathon training",
    blocks: [
      section("run_plan", "Plan", [
        "Sixteen weeks, four runs a week, one long",
        "Long run grows ten percent a week, then drops",
        "Two easy weeks before the race, do not panic",
        "Race is the first Sunday in October",
      ]),
      section("run_niggles", "Niggles", [
        "Left knee complains on downhills after fourteen miles",
        "Calf tightness is always the shoes being old",
        "Rolling the arch out helps more than stretching",
        "[ ] Book a gait assessment before the shoes go",
      ]),
      section("run_fuel", "Fuelling", [
        "A gel every forty five minutes, from mile six",
        "Practise the race breakfast on long run days",
        "Too much coffee before a long one is a mistake",
        "Salt tablets only when it is properly warm",
      ]),
      section("run_log", "Log", [
        "Sunday: eighteen miles, felt easy until sixteen",
        "Tuesday: eight by eight hundred, on pace",
        "Thursday: recovery five, legs heavy",
        "Saturday: parkrun as a tempo, 21:40",
      ]),
    ],
  },
  {
    id: "note_rust",
    title: "Learning Rust",
    blocks: [
      section("rust_own", "Ownership", [
        "Every value has one owner and the owner drops it",
        "Borrowing hands out a reference without giving it away",
        "You may have many readers or one writer, never both",
        "Lifetimes are the compiler asking you to prove it outlives",
      ]),
      section("rust_err", "Errors", [
        "Result everywhere, the question mark does the plumbing",
        "anyhow for applications, thiserror for libraries",
        "Panics are for bugs, not for failures you expect",
      ]),
      section("rust_async", "Async", [
        "A future does nothing until something polls it",
        "Tokio is the runtime everyone actually uses",
        "Send and Sync bounds leak everywhere once you spawn",
        "[ ] Read the pinning chapter properly, not skim it",
      ]),
    ],
  },
  {
    id: "note_move",
    title: "House move",
    blocks: [
      section("move_admin", "Admin", [
        "[x] Redirect post for six months",
        "[ ] Tell the council about the council tax band",
        "[ ] Move the broadband, fourteen days notice",
        "[ ] Water meter reading on the morning of",
        "Insurance needs to overlap both places by a day",
      ]),
      section("move_survey", "Survey", [
        "Damp in the back bedroom, north facing wall",
        "Surveyor thinks it is condensation, not rising",
        "Roof has ten years left, flashing needs doing sooner",
        "Electrics predate the current regs but are safe",
      ]),
      section("move_money", "Money", [
        "Stamp duty is the number that ruins the spreadsheet",
        "Solicitor quoted fourteen hundred plus disbursements",
        "Keep three months of payments back as a cushion",
      ]),
    ],
  },
  {
    id: "note_work",
    title: "Work",
    blocks: [
      section("work_team", "Team", [
        "Standup is fifteen minutes and often is not",
        "Two people own the deploy pipeline, one is leaving",
        "Nobody owns the flaky integration suite",
        "[ ] Write down who is on call over the holidays",
      ]),
      section("work_incident", "Incident review", [
        "The rollout went to every region at once",
        "Nobody could tell whether it was worse than before",
        "The dashboard showed averages, which hid the tail",
        "We found it because a customer emailed",
        "Action: stage rollouts behind a percentage",
      ]),
      section("work_perf", "Performance", [
        "The slow endpoint was doing a query per row",
        "Joining fixed it, the fix was four characters",
        "Caching would have hidden the problem for a year",
      ]),
      section("work_hiring", "Hiring", [
        "The take home should take two hours, not eight",
        "Ask them to read code, not only to write it",
        "A good interview leaves them knowing more about us",
      ]),
    ],
  },
  {
    id: "note_daily_0812",
    title: "2026-08-12",
    blocks: [
      section("d812_am", "Morning", [
        "Slept badly, the room was too warm",
        "Walked to the station instead of driving",
        "Read the first chapter on the train",
      ]),
      section("d812_work", "Work", [
        "Paired on the deploy script for two hours",
        "The staging database was out of date again",
        "[x] Reply to the security questionnaire",
      ]),
      section("d812_pm", "Evening", [
        "Made the tomato thing with too much garlic",
        "Watched half a film and fell asleep",
      ]),
    ],
  },
  {
    id: "note_daily_0819",
    title: "2026-08-19",
    blocks: [
      section("d819_am", "Morning", [
        "Ran six miles before it got hot",
        "Coffee at the place by the bridge",
      ]),
      section("d819_work", "Work", [
        "Long argument about whether to rewrite the importer",
        "Decided to leave it and write a test instead",
        "The oncall pager went off for a disk filling up",
      ]),
      section("d819_think", "Thinking", [
        "I keep writing things down and never reading them back",
        "Search is the only part of a notebook that compounds",
      ]),
    ],
  },
  {
    id: "note_daily_0903",
    title: "2026-09-03",
    blocks: [
      section("d903_am", "Morning", [
        "First cold morning, the heating clicked on",
        "Bike had a slow puncture, walked it in",
      ]),
      section("d903_work", "Work", [
        "Wrote the migration and did not deploy it yet",
        "Reviewed two pull requests, both fine",
        "[ ] Ask about the budget for next quarter",
      ]),
    ],
  },
  {
    id: "note_guitar",
    title: "Guitar",
    blocks: [
      section("gtr_practice", "Practice", [
        "Twenty minutes daily beats two hours on Sunday",
        "Metronome slower than feels dignified",
        "Record it, listen back, wince, repeat",
      ]),
      section("gtr_theory", "Theory", [
        "The circle is just fifths stacked until they wrap",
        "Minor pentatonic is five shapes, one moved",
        "A dominant seventh wants to go somewhere",
      ]),
      section("gtr_gear", "Gear", [
        "Strings die after about three weeks of playing",
        "The amp hums unless it shares a socket with nothing",
        "Nothing sounds better than playing in tune",
      ]),
    ],
  },
  {
    id: "note_garden",
    title: "Garden",
    blocks: [
      section("grd_beds", "Beds", [
        "The back bed gets sun only after two o'clock",
        "Clay under fifteen centimetres of decent topsoil",
        "Mulch in autumn, the worms do the digging",
      ]),
      section("grd_veg", "Vegetables", [
        "Tomatoes in pots by the wall, they like the heat",
        "Courgettes produce until you beg them to stop",
        "Slugs take every single bean seedling, every year",
        "[ ] Start the chillies indoors in February",
      ]),
      section("grd_tree", "Trees", [
        "The apple needs a winter prune, open the middle",
        "Do not prune the plum in winter or it gets silver leaf",
      ]),
    ],
  },
  {
    id: "note_photo",
    title: "Photography",
    blocks: [
      section("pho_kit", "Kit", [
        "One body, two primes, that is the whole bag",
        "The 35 lives on the camera and always has",
        "A tripod you do not carry is not a tripod",
      ]),
      section("pho_craft", "Craft", [
        "Get closer, then get closer than that",
        "Light first, subject second, gear a distant last",
        "The best hour is the one before the sun goes",
        "Shoot raw, the shadows are where the picture hides",
      ]),
      section("pho_edit", "Editing", [
        "Fix the white balance before anything else",
        "Most photos want less contrast than you think",
        "Export twice, one for print and one for screens",
      ]),
    ],
  },
  {
    id: "note_money",
    title: "Finances",
    blocks: [
      section("fin_budget", "Budget", [
        "Fixed costs first, then savings, then the rest",
        "The subscriptions creep up on you every year",
        "[ ] Cancel the thing we have not opened since March",
      ]),
      section("fin_invest", "Investing", [
        "Index funds and then do nothing for thirty years",
        "Fees compound the same way returns do, backwards",
        "Timing the market is a story about hindsight",
      ]),
      section("fin_tax", "Tax", [
        "Self assessment deadline is the end of January",
        "Keep the receipts in one folder, not five apps",
        "Pension contributions come off the top",
      ]),
    ],
  },
  {
    id: "note_japan",
    title: "Japan",
    blocks: [
      section("jp_plan", "Plan", [
        "Two weeks, Tokyo, Kanazawa, Kyoto, back",
        "The rail pass only pays if you do the long legs",
        "Book the mountain hut months ahead or forget it",
      ]),
      section("jp_food", "Food", [
        "The best meal was a basement counter with six seats",
        "Convenience store egg sandwiches are not a joke",
        "Say what you want and stop talking, it is not rude",
      ]),
      section("jp_move", "Getting around", [
        "Trains leave at the minute they say they leave",
        "Luggage forwarding beats dragging a case on a train",
        "Cash still matters outside the big cities",
      ]),
    ],
  },
  {
    id: "note_coffee",
    title: "Coffee",
    blocks: [
      section("cof_grind", "Grinding", [
        "Grind size changes everything, dose changes little",
        "Burrs not blades, this is the whole argument",
        "Weigh the beans, guessing costs more than the scale",
      ]),
      section("cof_brew", "Brewing", [
        "Sour means under extracted, bitter means over",
        "Water just off the boil, not boiling",
        "A 1:16 ratio is a fine place to start arguing from",
      ]),
      section("cof_beans", "Beans", [
        "Rest them a week after roast, then use them fast",
        "The bag date that matters is roasted, not best before",
      ]),
    ],
  },
  {
    id: "note_car",
    title: "Car",
    blocks: [
      section("car_service", "Servicing", [
        "MOT is due the second week of November",
        "Oil every ten thousand or once a year, whichever first",
        "The garage on the bypass is honest and slow",
      ]),
      section("car_faults", "Faults", [
        "Squeal when cold that goes away after a mile",
        "Front pads were down to two millimetres",
        "The warning light means the sensor, not the brakes",
        "[ ] Get the tracking checked, it pulls left",
      ]),
      section("car_winter", "Winter", [
        "Tyre pressure drops with the temperature",
        "Keep a scraper in the door, not in the boot",
      ]),
    ],
  },
  {
    id: "note_weather",
    title: "Weather station",
    blocks: [
      section("ws_hw", "Hardware", [
        "ESP32 on the shed roof, solar and a small cell",
        "The temperature sensor must be shaded or it lies",
        "Deep sleep between readings or the battery dies by March",
        "Anemometer count is interrupts, debounce it",
      ]),
      section("ws_data", "Data", [
        "Readings every five minutes, posted over MQTT",
        "Store the raw values, derive everything else later",
        "A gap in the series is information, do not fill it",
        "[ ] Backfill the week the cell was flat",
      ]),
      section("ws_lessons", "Lessons", [
        "Outdoor electronics fail at the connectors first",
        "Everything gets wet eventually, plan for it",
      ]),
    ],
  },
  {
    id: "note_health",
    title: "Health",
    blocks: [
      section("hth_sleep", "Sleep", [
        "Same wake time every day matters more than bedtime",
        "The room wants to be cold, dark and boring",
        "Screens late push everything an hour later",
      ]),
      section("hth_gp", "Appointments", [
        "Blood test results come back in three working days",
        "Ask for the numbers, not only the word normal",
        "[ ] Book the dentist, it has been eighteen months",
      ]),
      section("hth_back", "Back", [
        "Sitting badly for six hours is the whole problem",
        "Walking beats any stretch that promises a fix",
      ]),
    ],
  },
]

/**
 * The second half of the corpus: more notes, and the thing the first half was
 * missing — LENGTH VARIANCE. Production's longest block is 175 characters
 * against a mean of 41, so a corpus of uniformly short bullets is not the
 * shape being tested. These notes mix bullets with occasional paragraph blocks
 * of 100–175 characters.
 *
 * They also exist to be CONFUSABLE. A retriever looks good on a corpus where
 * every note is about something different; the notes below deliberately
 * collide with the first half — a bicycle with brakes that squeal, a database
 * that replicates, a baby that will not sleep, a different kind of tapering —
 * so a near-miss has somewhere to go.
 */
const DISTRACTOR_NOTES: FixtureNote[] = [
  {
    id: "note_bike",
    title: "Bicycle",
    blocks: [
      section("bik_brakes", "Brakes", [
        "Rim brakes squeal when the pads glaze over",
        "Toe the pads in very slightly at the front",
        "Wet weather doubles the stopping distance",
        "Cables stretch in the first month, then settle",
      ]),
      section("bik_drive", "Drivetrain", [
        "Chain wear gauge is three pounds and saves a cassette",
        "Degrease it properly or the new lube does nothing",
        "A skipping gear is usually the cable, not the chain",
      ]),
      {
        id: "bik_note_0",
        type: "text",
        text: "Bought the bike second hand in 2019 and it has needed a bottom bracket, two chains and a rear wheel rebuild since, which is roughly what everyone said would happen.",
      },
      section("bik_commute", "Commute", [
        "Eleven miles each way, forty minutes with the lights",
        "The canal path floods after two days of rain",
        "Lights on all year, drivers do not see you",
      ]),
    ],
  },
  {
    id: "note_postgres",
    title: "Postgres",
    blocks: [
      section("pg_repl", "Replication", [
        "Streaming replication ships the write ahead log",
        "A replica that falls behind is a replica that lies",
        "Logical replication lets you filter by table",
        "Failover is easy, failing back is where it hurts",
      ]),
      section("pg_index", "Indexes", [
        "An index the planner does not use is pure cost",
        "Partial indexes for the rows you actually query",
        "Explain analyse, do not guess, ever",
      ]),
      {
        id: "pg_note_0",
        type: "text",
        text: "The autovacuum settings that ship with the default configuration assume a much smaller table than ours, and the bloat did not become visible until a query plan flipped.",
      },
      section("pg_locks", "Locks", [
        "Adding a column with a default used to rewrite the table",
        "A long transaction holds back cleanup for everyone",
        "Lock timeouts are cheaper than a stuck migration",
      ]),
    ],
  },
  {
    id: "note_baby",
    title: "Baby",
    blocks: [
      section("bby_sleep", "Sleep", [
        "Four month regression is real and it is brutal",
        "Dark room, white noise, boring routine, repeat",
        "Nothing works for more than about nine days",
      ]),
      section("bby_feed", "Feeding", [
        "Weaning starts with whatever we are eating anyway",
        "Everything ends up on the floor for six weeks",
      ]),
      {
        id: "bby_note_0",
        type: "text",
        text: "The advice from every book contradicts the advice from every other book, and the only consistent finding is that the child has not read any of them.",
      },
      section("bby_kit", "Kit", [
        "The expensive pram was worth it, the rest was not",
        "Two thermometers, they never agree",
      ]),
    ],
  },
  {
    id: "note_climbing",
    title: "Climbing",
    blocks: [
      section("clb_tech", "Technique", [
        "Straight arms, bent legs, push do not pull",
        "Quiet feet, the noisy ones are the ones slipping",
        "Read the whole route before touching it",
      ]),
      section("clb_fingers", "Fingers", [
        "Pulley strains come from crimping when tired",
        "Take the rest week, the tendons are slower than muscle",
        "Warm up for twenty minutes or pay for it later",
      ]),
      section("clb_gear", "Gear", [
        "Shoes should hurt a bit, not a lot",
        "Rope goes in the bag clean or it dies early",
      ]),
    ],
  },
  {
    id: "note_kubernetes",
    title: "Kubernetes",
    blocks: [
      section("k8s_pods", "Pods", [
        "A pod without limits will eventually eat a node",
        "Readiness and liveness probes are not the same thing",
        "Restarting a crash loop faster does not fix anything",
      ]),
      section("k8s_net", "Networking", [
        "Service discovery is DNS with extra steps",
        "An ingress is a load balancer with opinions",
        "Network policies default to allowing everything",
      ]),
      {
        id: "k8s_note_0",
        type: "text",
        text: "Most of the complexity we hit was not the scheduler but the ninety different YAML files describing what we wanted, none of which agreed about the image tag.",
      },
      section("k8s_ops", "Operations", [
        "Drain a node before you patch it, always",
        "Rolling updates hide a failure until the last replica",
      ]),
    ],
  },
  {
    id: "note_woodwork",
    title: "Woodwork",
    blocks: [
      section("wd_sharp", "Sharpening", [
        "A dull chisel is more dangerous than a sharp one",
        "Flatten the back once, properly, then never again",
        "Strop between sharpenings and sharpen less often",
      ]),
      section("wd_joints", "Joints", [
        "Cut to the line, not near it",
        "Dry fit everything before glue touches anything",
        "Clamps do not fix a bad joint, they hide it",
      ]),
      {
        id: "wd_note_0",
        type: "text",
        text: "The shelf came out square but the wall did not, so the scribe took longer than the joinery and taught me more than the joinery did.",
      },
      section("wd_finish", "Finishing", [
        "Sand up to 180 and stop, higher does nothing here",
        "Oil is forgiving, lacquer is not",
      ]),
    ],
  },
  {
    id: "note_chess",
    title: "Chess",
    blocks: [
      section("chs_open", "Openings", [
        "Learn ideas not moves, the moves fall out",
        "Two openings as white is plenty for years",
        "Getting punished in the opening is rare below club level",
      ]),
      section("chs_end", "Endgames", [
        "King and pawn is the one that actually pays",
        "Opposition wins more games than any opening line",
        "Rook endgames are drawn until someone blunders",
      ]),
      section("chs_habit", "Habits", [
        "Blunder check before every single move",
        "Playing tired is the same as playing badly",
      ]),
    ],
  },
  {
    id: "note_spanish",
    title: "Spanish",
    blocks: [
      section("spa_verbs", "Verbs", [
        "Subjunctive is a mood, not a tense, this helped",
        "Preterite for what happened, imperfect for what was",
        "Ser and estar is permanence versus state, roughly",
      ]),
      section("spa_study", "Study", [
        "Fifteen minutes daily beats an hour on Saturday",
        "Listening is the slowest skill and the last to come",
        "Reading children's books is not embarrassing",
      ]),
      {
        id: "spa_note_0",
        type: "text",
        text: "After eight months the thing that changed was not vocabulary but being willing to say something wrong quickly rather than something correct slowly.",
      },
    ],
  },
  {
    id: "note_beer",
    title: "Brewing beer",
    blocks: [
      section("beer_mash", "Mash", [
        "Sixty six degrees for a beer that finishes dry",
        "Mash pH matters more than the water salts do",
        "Sparge slowly or you pull tannins out of the husk",
      ]),
      section("beer_ferm", "Fermentation", [
        "Pitch enough yeast, underpitching makes it taste odd",
        "Temperature control is the biggest single upgrade",
        "Let it finish before you even think about packaging",
      ]),
      section("beer_dry", "Dry hopping", [
        "Cold side hops go in after the krausen drops",
        "Oxygen at packaging kills a hoppy beer in a fortnight",
      ]),
    ],
  },
  {
    id: "note_cabin",
    title: "Cabin",
    blocks: [
      section("cab_build", "Build", [
        "Concrete pads rather than a slab, the ground moves",
        "Insulate the floor as well as the walls",
        "A vapour barrier in the wrong place traps water",
      ]),
      section("cab_power", "Power", [
        "Two hundred watts of panel runs everything but the kettle",
        "Lead acid dies if you take it below half",
        "Run the cable in conduit even underground",
      ]),
      {
        id: "cab_note_0",
        type: "text",
        text: "The stove is oversized for the space, which sounds like a mistake but means it can be run gently and cleanly rather than roaring all evening.",
      },
      section("cab_water", "Water", [
        "Drain everything before the first hard frost",
        "Rainwater off the roof is fine for everything but drinking",
      ]),
    ],
  },
  {
    id: "note_writing",
    title: "Writing",
    blocks: [
      section("wri_draft", "Drafting", [
        "Write the ending first, then earn it",
        "A bad first draft is the only kind there is",
        "Cut the first paragraph, it is always throat clearing",
      ]),
      section("wri_edit", "Editing", [
        "Read it aloud, the ear finds what the eye skips",
        "Adverbs are usually a verb that gave up",
        "If two sentences say it, one of them is wrong",
      ]),
      {
        id: "wri_note_0",
        type: "text",
        text: "The pieces that landed were the ones where I had an argument I actually believed, and the ones that did not were the ones assembled out of things that sounded true.",
      },
    ],
  },
  {
    id: "note_pension",
    title: "Pension",
    blocks: [
      section("pen_plan", "Plan", [
        "Employer matches five percent, take all of it",
        "Consolidating the old pots took four months of forms",
        "Fees of one percent cost a quarter of the pot over thirty years",
      ]),
      section("pen_alloc", "Allocation", [
        "Global equity until close to drawing it",
        "Bonds are for sequence risk, not for returns",
        "Rebalance annually and otherwise leave it alone",
      ]),
    ],
  },
  {
    id: "note_daily_0910",
    title: "2026-09-10",
    blocks: [
      section("d910_am", "Morning", [
        "Woke before the alarm, which never happens",
        "The boiler is making the noise again",
      ]),
      section("d910_work", "Work", [
        "Spent the morning reading someone else's code",
        "Shipped the fix, watched the graph, went for lunch",
        "[ ] Follow up on the thing from the retro",
      ]),
      section("d910_pm", "Evening", [
        "Cooked properly for the first time in a week",
        "Started the book everyone keeps mentioning",
      ]),
    ],
  },
  {
    id: "note_first_aid",
    title: "First aid",
    blocks: [
      section("fa_basics", "Basics", [
        "Danger, response, airway, breathing, in that order",
        "Call for help before you start compressions",
        "Thirty compressions to two breaths, push hard",
      ]),
      section("fa_burns", "Burns", [
        "Cool running water for twenty minutes, nothing else",
        "Cling film loosely, never a tight bandage",
      ]),
      section("fa_bleed", "Bleeding", [
        "Pressure directly on the wound and keep it there",
        "Do not keep lifting the dressing to look",
      ]),
    ],
  },
]

/**
 * Filler, and it earns its place: without it the corpus is 434 blocks and
 * production is 634, which is a third fewer things for a query to be wrong
 * about. None of these notes is a target; they exist to be in the way.
 */
const FILLER_NOTES: FixtureNote[] = [
  {
    id: "note_diy",
    title: "DIY",
    blocks: [
      section("diy_walls", "Walls", [
        "Find the joists before hanging anything heavy",
        "Filler shrinks, so do it twice and sand between",
        "Mist coat new plaster or the paint peels off",
        "Cutting in by hand beats taping every time",
      ]),
      section("diy_plumb", "Plumbing", [
        "Isolate at the valve, then open the lowest tap",
        "PTFE tape goes clockwise, the way the thread turns",
        "A dripping tap is nearly always the washer",
      ]),
      section("diy_elec", "Electrics", [
        "Test the tester before you trust the tester",
        "Old lighting circuits have no earth at the switch",
      ]),
      {
        id: "diy_note_0",
        type: "text",
        text: "The rule that has saved the most time is to buy the right tool at the start of the job rather than at the point where the wrong one has already ruined something.",
      },
    ],
  },
  {
    id: "note_dog",
    title: "Dog",
    blocks: [
      section("dog_train", "Training", [
        "Reward the behaviour you want within two seconds",
        "Recall is the only command that really matters",
        "A tired dog is a well behaved dog, mostly",
        "Never call them to you to tell them off",
      ]),
      section("dog_health", "Health", [
        "Worming every three months, flea treatment monthly",
        "Weight creeps up and the vet will tell you first",
        "Grass seeds in the ears in July, check after walks",
      ]),
      section("dog_walks", "Walks", [
        "The woods loop is fifty minutes and always empty",
        "Livestock field in spring means lead on, no arguing",
      ]),
    ],
  },
  {
    id: "note_meetings",
    title: "Meetings",
    blocks: [
      section("mtg_run", "Running one", [
        "An agenda or it is a phone call with extra people",
        "Decide something or do not have it",
        "Write the decision down where others will find it",
        "Half an hour is a default, not a law",
      ]),
      section("mtg_notes", "Notes", [
        "Actions need a name attached or they evaporate",
        "Send the summary the same day or not at all",
      ]),
      section("mtg_remote", "Remote", [
        "Cameras on for the first five minutes, then whatever",
        "One person in a room and five on a call never works",
      ]),
    ],
  },
  {
    id: "note_pasta",
    title: "Pasta",
    blocks: [
      section("pst_dough", "Dough", [
        "A hundred grams of flour to one egg, roughly",
        "Knead for ten minutes, rest for thirty",
        "Semolina for dusting, flour makes it gummy",
      ]),
      section("pst_sauce", "Sauce", [
        "Finish the pasta in the pan with the sauce",
        "The starchy water is the emulsifier, save a cup",
        "Garlic burns in the time it takes to answer the door",
        "Anchovies dissolve and nobody notices them",
      ]),
      section("pst_shapes", "Shapes", [
        "Ridged shapes for thick sauces, long for oily ones",
        "Fresh does not beat dried, it is a different thing",
      ]),
    ],
  },
  {
    id: "note_mountains",
    title: "Hill walking",
    blocks: [
      section("hil_nav", "Navigation", [
        "Take a bearing before the cloud comes down, not after",
        "Pacing and timing beats a phone with a flat battery",
        "The map lives somewhere you can reach it in wind",
      ]),
      section("hil_kit", "Kit", [
        "Waterproofs that have not been reproofed are not",
        "Spare warm layer stays in the bag unused, that is fine",
        "Head torch even on a summer afternoon walk",
      ]),
      section("hil_weather", "Weather", [
        "Wind chill on a ridge is the thing that gets people",
        "Turning back is a skill, not a failure",
      ]),
      {
        id: "hil_note_0",
        type: "text",
        text: "Two of the three times things have gone wrong it was because we were late, and being late made every subsequent decision worse rather than because of the weather itself.",
      },
    ],
  },
  {
    id: "note_email",
    title: "Email",
    blocks: [
      section("eml_flow", "Process", [
        "Inbox is a queue, not a filing cabinet",
        "Two minutes or less, do it now",
        "Anything needing thought gets a time in the calendar",
      ]),
      section("eml_write", "Writing", [
        "Say what you want in the first sentence",
        "One topic per message or half of it gets ignored",
        "Nobody reads past the fold on a phone",
      ]),
    ],
  },
  {
    id: "note_typescript",
    title: "TypeScript",
    blocks: [
      section("ts_types", "Types", [
        "Unknown is the honest any, use it at boundaries",
        "A discriminated union beats a bag of optionals",
        "Narrowing is the whole language once you see it",
        "Satisfies checks without widening the inferred type",
      ]),
      section("ts_build", "Build", [
        "Project references make a big repo compile twice as fast",
        "Isolated modules forbids the const enum you wanted",
      ]),
      section("ts_test", "Testing", [
        "Type tests catch the refactor that compiles and lies",
        "Mocking a module is usually a design smell",
      ]),
    ],
  },
  {
    id: "note_daily_0826",
    title: "2026-08-26",
    blocks: [
      section("d826_am", "Morning", [
        "Rained all night, the gutter is blocked again",
        "Skipped breakfast and regretted it by ten",
      ]),
      section("d826_work", "Work", [
        "Three meetings that could have been one document",
        "Finally deleted the module nobody imports",
      ]),
      section("d826_pm", "Evening", ["Walked the dog in the dark for the first time this year"]),
    ],
  },
]

FIXTURE_NOTES.push(...DISTRACTOR_NOTES, ...FILLER_NOTES)

/**
 * The queries, each PARAPHRASED away from the block it should find. Two
 * groups, on purpose:
 *
 * - `semantic`: no meaningful word overlap with the target. This is the case
 *   embeddings exist for, and the case substring and fuzzy matching cannot do.
 * - `lexical`: the query names the thing — jargon, a number, a proper noun.
 *   This is where embeddings are WORST and a fuzzy matcher is perfect, and it
 *   is in the set so the comparison is not rigged.
 */
export interface FixtureQuery {
  query: string
  /** The block id a good answer returns. */
  target: string
  kind: "semantic" | "lexical"
}

export const FIXTURE_QUERIES: FixtureQuery[] = [
  {
    query: "why did the app read so much from the database",
    target: "rum_cost_1",
    kind: "semantic",
  },
  { query: "how do deletions reach other devices", target: "rum_sync_6", kind: "semantic" },
  { query: "what stops two devices clobbering each other", target: "rum_sync_1", kind: "semantic" },
  { query: "seq is assigned where", target: "rum_sync_3", kind: "lexical" },
  { query: "bread is too wet to shape", target: "dough_mix_0", kind: "semantic" },
  { query: "how to get big holes in the crumb", target: "dough_bake_0", kind: "semantic" },
  { query: "starter smells like nail varnish", target: "dough_starter_1", kind: "semantic" },
  { query: "autolyse", target: "dough_mix_1", kind: "lexical" },
  { query: "internet keeps dropping on video calls", target: "net_trouble_0", kind: "semantic" },
  { query: "bulbs will not join the network", target: "net_wifi_3", kind: "semantic" },
  { query: "pi-hole", target: "net_dns_0", kind: "lexical" },
  { query: "my knee hurts on long runs", target: "run_niggles_0", kind: "semantic" },
  { query: "what to eat during the race", target: "run_fuel_0", kind: "semantic" },
  { query: "tapering before race day", target: "run_plan_2", kind: "semantic" },
  { query: "compiler complains about references", target: "rust_own_2", kind: "semantic" },
  { query: "which error crate for a library", target: "rust_err_1", kind: "lexical" },
  { query: "nothing happens until you await", target: "rust_async_0", kind: "semantic" },
  { query: "who to tell when we change address", target: "move_admin_1", kind: "semantic" },
  { query: "wet patch on the bedroom wall", target: "move_survey_0", kind: "semantic" },
  { query: "why did nobody notice the outage", target: "work_incident_2", kind: "semantic" },
  { query: "endpoint was slow because of n+1", target: "work_perf_0", kind: "semantic" },
  { query: "take home exercise length", target: "work_hiring_0", kind: "lexical" },
  { query: "feeling like notes are write only", target: "d819_think_0", kind: "semantic" },
  { query: "vegetables keep getting eaten", target: "grd_veg_2", kind: "semantic" },
  { query: "when to cut back the plum tree", target: "grd_tree_1", kind: "semantic" },
  { query: "how often to change strings", target: "gtr_gear_0", kind: "semantic" },
  { query: "practice little and often", target: "gtr_practice_0", kind: "semantic" },
  { query: "coffee tastes harsh and bitter", target: "cof_brew_0", kind: "semantic" },
  { query: "should I buy a better grinder", target: "cof_grind_1", kind: "semantic" },
  // Deliberately disambiguated: the Bicycle note also has squealing brakes,
  // and a query that did not say which vehicle would have no right answer.
  { query: "the car squeals when I first drive off", target: "car_faults_0", kind: "semantic" },
  { query: "MOT", target: "car_service_0", kind: "lexical" },
  { query: "sensor readings in the sun are wrong", target: "ws_hw_1", kind: "semantic" },
  { query: "battery flat over winter", target: "ws_hw_2", kind: "semantic" },
  { query: "cannot get to sleep", target: "hth_sleep_1", kind: "semantic" },
  { query: "photos look flat after editing", target: "pho_edit_1", kind: "semantic" },
  { query: "best time of day to shoot", target: "pho_craft_2", kind: "semantic" },
  { query: "should I try to time the market", target: "fin_invest_2", kind: "semantic" },
  { query: "when is the tax return due", target: "fin_tax_0", kind: "semantic" },
  { query: "getting suitcases between cities", target: "jp_move_1", kind: "semantic" },
  { query: "is the rail pass worth it", target: "jp_plan_1", kind: "lexical" },
  { query: "the standby server is behind", target: "pg_repl_1", kind: "semantic" },
  { query: "query suddenly got slow after months", target: "pg_note_0", kind: "semantic" },
  { query: "container keeps restarting over and over", target: "k8s_pods_2", kind: "semantic" },
  { query: "one service used all the memory on the box", target: "k8s_pods_0", kind: "semantic" },
  { query: "gears jumping under load", target: "bik_drive_2", kind: "semantic" },
  { query: "finger injury from hanging on small holds", target: "clb_fingers_0", kind: "semantic" },
  { query: "child stopped sleeping through", target: "bby_sleep_0", kind: "semantic" },
  { query: "chisel will not cut cleanly", target: "wd_sharp_0", kind: "semantic" },
  { query: "how much solar do I need off grid", target: "cab_power_0", kind: "semantic" },
  { query: "my prose is too wordy", target: "wri_edit_2", kind: "semantic" },
  { query: "what to do for a scald", target: "fa_burns_0", kind: "semantic" },
  { query: "compressions to breaths ratio", target: "fa_basics_2", kind: "lexical" },
  { query: "beer went stale quickly", target: "beer_dry_1", kind: "semantic" },
  { query: "how much does the employer put in", target: "pen_plan_0", kind: "semantic" },
]
