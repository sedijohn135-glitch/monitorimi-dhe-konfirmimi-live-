/**
 * entry-models.mjs — the 22 entry models of MULTISNIPER07 v6.0, written
 * so the monitor can act on them rather than only print their names.
 *
 * Before this module `setup_model` was a free-text label. It reached
 * Telegram and went no further: a Silver Bullet registered at 5 PM and a
 * Silver Bullet registered inside its own window were the same setup to
 * the monitor, and Model 16 — whose entire content is "do not take this
 * trade" — registered like any other.
 *
 * So each model here carries two things:
 *
 *   1. its Trigger / Validation / Invalidation in the operator's own
 *      words, which is what the Telegram messages quote; and
 *   2. a `policy` block of the parts a machine can actually check —
 *      the session window, the weekday, the allowed direction, which
 *      defence the setup owes, whether its invalidation is a body close,
 *      and how many bars it has to start working.
 *
 * The policy is deliberately small. A model's real trigger — "FVG after
 * a sweep and a BOS" — is read by the analysis from the chart and
 * arrives as the setup's own levels; re-deriving it here would be a
 * second opinion competing with the first. What is left is what the
 * analysis cannot know when it writes the setup, because it depends on
 * *when price arrives*: the window may have closed, the day may have
 * turned, the model may forbid this direction outright.
 *
 * Two policy fields are refusals at registration (`tradable`,
 * `directions`) because they can never come true later. Everything else
 * is a live gate: it withholds an entry while it is false and lets it
 * through when it is true, exactly like the kill-zone and news gates
 * already in place.
 *
 * **A window blocks only where the model's own Invalidation names the
 * clock.** That is the three Silver Bullets and nothing else: §5.1 makes
 * their hour the model, and their Invalidation line says so outright —
 * "mbyllja e dritares kohore". Every other model names a price event as
 * its invalidation, so its window is context, not a gate, and it is
 * recorded as a note the entry message carries rather than a refusal.
 *
 * This is not a softening. A real setup arrived reading
 * `MODEL: 13 (Opening Range PM)` timestamped 13:41 NY — inside the PM
 * Opening Range, before the 14:00 the strict reading of the model wants.
 * A hard window would have withheld that entry for nineteen minutes and
 * quite possibly for good, on a setup whose own declared invalidation is
 * "thyerja e kufirit të kundërt të Opening Range" and has nothing to do
 * with the clock. A gate that refuses entries the analysis meant is
 * worse than no gate: it fails silently, in the direction of doing
 * nothing, which is the one failure the operator cannot see.
 *
 * Nothing here performs I/O or reads the environment.
 */

import { isWindowActive, nyClock, toMinutes } from "./core.mjs";

export const DEFAULT_TIME_STOP_BARS = 12; // M5 bars — one hour

/**
 * Free text in, one model out. The analyst writes "Silver Bullet (10-11
 * AM)", "Modeli 7", "SB AM" or "silver_bullet_am" for the same thing, so
 * matching is on a normalised form and the longest matching alias wins —
 * otherwise "silver bullet" would claim a string that says which window
 * it means.
 */
export function normaliseModelText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ë", "e")
    .replaceAll("ç", "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const M = (number, key, name, aliases, prose, policy, catalogue = "v6.0") =>
  Object.freeze({
    number,
    key,
    name,
    catalogue,
    aliases: Object.freeze(aliases.map(normaliseModelText)),
    trigger: prose.trigger,
    validation: prose.validation,
    invalidation: prose.invalidation,
    policy: Object.freeze({
      tradable: true,
      directions: null, // null = the model does not constrain direction
      window: null,
      windowMode: "HARD",
      windowCloseInvalidates: false,
      days: null,
      defence: "standard",
      invalidationRule: "touch",
      timeStopBars: DEFAULT_TIME_STOP_BARS,
      ...policy,
    }),
  });

// NY ET windows, matching the Iron Rules in §5.1 of the master prompt.
const SB_LONDON = Object.freeze({ name: "Silver Bullet London", start: "03:00", end: "04:00" });
const SB_AM = Object.freeze({ name: "Silver Bullet AM", start: "10:00", end: "11:00" });
const SB_PM = Object.freeze({ name: "Silver Bullet PM", start: "14:00", end: "15:00" });
const AFTER_AM_OR = Object.freeze({ name: "Pas NY Opening Range", start: "07:30", end: "12:00" });
const AFTER_PM_OR = Object.freeze({ name: "Pas PM Opening Range", start: "14:00", end: "16:00" });
const PM_CONTINUATION = Object.freeze({ name: "PM Continuation", start: "13:00", end: "16:00" });
const MODEL2_WINDOW = Object.freeze({ name: "Model 2 Amplified", start: "06:00", end: "10:00" });
const JUDAS_WINDOW = Object.freeze({ name: "Midnight Open → NY Open", start: "00:00", end: "10:00" });

export const ENTRY_MODELS = Object.freeze([
  M(1, "ICT_2022", "ICT 2022 Model",
    ["ict 2022", "ict2022", "ict 2022 model", "modeli bazë", "model 1"],
    {
      trigger: "Çmimi prek FVG pas një sweep të SSL/BSL dhe një BOS në LTF.",
      validation: "Mbyllja e trupit të qiririt brenda zonës FVG pa e kapërcyer atë.",
      invalidation: "Mbyllje e trupit jashtë ekstremit të strukturës (swing anchor).",
    },
    { invalidationRule: "body_close", timeStopBars: 18 }),

  M(2, "MARKET_ANCHOR", "Market Anchor Buy/Sell",
    ["market anchor", "anchor buy", "anchor sell", "ath anchor"],
    {
      trigger: "Sweep i ATH + formimi i Inversion FVG.",
      validation: "Trupi i qiririt mbetet brenda kufijve të anchor-it.",
      invalidation: "Çmimi thyen me trup nivelin e lartë/ultë të anchor-it.",
    },
    // Iron Rule 5: never short into an ATH without institutional bearish
    // confirmation, and this model is the ATH model. A short registered
    // on it is a different model wearing its name.
    { directions: Object.freeze(["buy"]), invalidationRule: "body_close" }),

  M(3, "MODEL_2_AMPLIFIED", "ICT Price Action Model 2 Amplified",
    ["model 2 amplified", "price action model 2", "model2 amplified", "amplified"],
    {
      trigger: "Ditë e Martë / e Mërkurë, ora 06:00 AM NY ET, çmimi në discount/premium PDA mujore/javore.",
      validation: "Rejection me wick në PDA.",
      invalidation: "Thyerja e plotë e PDA-së javore (HTF Cascade).",
    },
    {
      window: MODEL2_WINDOW,
      windowMode: "ADVISORY",
      days: Object.freeze(["Tue", "Wed"]),
      defence: "rejection_displacement",
      invalidationRule: "body_close",
    }),

  M(4, "TURTLE_SOUP", "Turtle Soup",
    ["turtle soup", "turtlesoup"],
    {
      trigger: "Shkelje e lehtë e Old High/Low (sweep) + largim i shpejtë (displacement).",
      validation: "Qiri me displacement në drejtim të kundërt.",
      invalidation: "Çmimi vazhdon lëvizjen pa u kthyer (continuation past sweep).",
    },
    { defence: "rejection_displacement", timeStopBars: 9 }),

  M(5, "TURTLE_SOUP_DEFERRED", "Turtle Soup Deferred + Rejection",
    ["turtle soup deferred", "deferred turtle", "turtle soup rejection"],
    {
      trigger: "Pas stop hunt, çmimi kthehet për retest të PDA-së.",
      validation: "Wick futet brenda PDA-së, por trupi mbyllet jashtë saj.",
      invalidation: "Mbyllje e trupit plotësisht brenda PDA-së (humbet respekti i wick-ut).",
    },
    { defence: "rejection_displacement", invalidationRule: "body_close" }),

  M(6, "SILVER_BULLET_LONDON", "Silver Bullet (London 3-4 AM)",
    ["silver bullet london", "silver bullet 3 4", "sb london", "london silver bullet"],
    {
      trigger: "Formimi i FVG brenda dritares 03:00–04:00 NY ET.",
      validation: "BMS paraprak në drejtimin e dëshiruar + FVG e paprekur.",
      invalidation: "Mbyllja e dritares kohore ose thyerja e FVG-së.",
    },
    { window: SB_LONDON, windowCloseInvalidates: true, timeStopBars: 6 }),

  M(7, "SILVER_BULLET_AM", "Silver Bullet (AM 10-11 AM)",
    ["silver bullet am", "silver bullet 10 11", "sb am", "am silver bullet"],
    {
      trigger: "Formimi i FVG brenda dritares 10:00–11:00 NY ET.",
      validation: "BMS paraprak në drejtimin e dëshiruar + FVG e paprekur.",
      invalidation: "Mbyllja e dritares kohore ose thyerja e FVG-së.",
    },
    { window: SB_AM, windowCloseInvalidates: true, timeStopBars: 6 }),

  M(8, "SILVER_BULLET_PM", "Silver Bullet (PM 2-3 PM)",
    ["silver bullet pm", "silver bullet 2 3", "sb pm", "pm silver bullet"],
    {
      trigger: "Formimi i FVG brenda dritares 14:00–15:00 NY ET.",
      validation: "BMS paraprak në drejtimin e dëshiruar + FVG e paprekur.",
      invalidation: "Mbyllja e dritares kohore ose thyerja e FVG-së.",
    },
    { window: SB_PM, windowCloseInvalidates: true, timeStopBars: 6 }),

  M(9, "OTE", "OTE (Optimal Trade Entry)",
    ["ote", "optimal trade entry", "fibo ote"],
    {
      trigger: "Pas BOS në LTF, tërheqja arrin zonën 0.618–0.79 të Fibos.",
      validation: "Rejection në zonën Fibo + zbehje e volumit.",
      invalidation: "Çmimi kalon nivelin 0.79 (ose 1.0) të shtrirjes.",
    },
    { defence: "rejection_displacement" }),

  M(10, "IOFED", "IOFED (Institutional Order Flow Entry Drill)",
    ["iofed", "institutional order flow entry drill", "nested fvg"],
    {
      trigger: "Çmimi hyn pjesërisht në FVG origjinale dhe krijon një FVG të re brenda saj (nested FVG).",
      validation: "Respektimi i 50% CE të FVG-së së brendshme.",
      invalidation: "Thyerja e kufirit të jashtëm të FVG-së origjinale.",
    },
    { invalidationRule: "body_close" }),

  M(11, "SMART_MONEY_STAGING", "Smart Money Three-Stage Staging (ATH)",
    ["smart money three stage", "three stage staging", "3 stage staging", "smart money staging"],
    {
      trigger: "3 faza të njëpasnjëshme shpërndarjeje mbi çmimet e mbylljes në zonën ATH.",
      validation: "Asnjë trup qiriri nuk mbyllet mbi Consequent Encroachment (CE).",
      invalidation: "Mbyllje e trupit të qiririt mbi CE.",
    },
    { directions: Object.freeze(["sell"]), invalidationRule: "body_close" }),

  M(12, "OPENING_RANGE_FPFVG_AM", "Opening Range First Presented FVG (AM)",
    ["opening range fvg am", "first presented fvg am", "or fpfvg am", "opening range am"],
    {
      trigger: "Pas përfundimit të Opening Range 07:00–07:30, shfaqet FVG e parë me opposing liquidity.",
      validation: "Displacement i qartë në drejtimin e FVG-së.",
      invalidation: "Thyerja e kufirit të kundërt të Opening Range.",
    },
    { window: AFTER_AM_OR, windowMode: "ADVISORY", defence: "rejection_displacement", invalidationRule: "body_close" }),

  M(13, "OPENING_RANGE_FPFVG_PM", "Opening Range First Presented FVG (PM)",
    ["opening range fvg pm", "first presented fvg pm", "or fpfvg pm", "opening range pm"],
    {
      trigger: "Pas përfundimit të Opening Range 13:30–14:00, shfaqet FVG e parë me opposing liquidity.",
      validation: "Displacement i qartë në drejtimin e FVG-së.",
      invalidation: "Thyerja e kufirit të kundërt të Opening Range.",
    },
    { window: AFTER_PM_OR, windowMode: "ADVISORY", defence: "rejection_displacement", invalidationRule: "body_close" }),

  M(14, "LUNCH_MACRO_PM", "NY Lunch Macro → PM Continuation",
    ["lunch macro", "ny lunch macro", "pm continuation", "lunch macro pm"],
    {
      trigger: "Pas orës 13:00 NY ET, pasi Lunch Macro Target është identifikuar që në orën 10:00 AM.",
      validation: "FVG formohet në sesionin PM në drejtimin e targetit të lënë pezull.",
      invalidation: "Targeti i drekës mblidhet dhe çmimi konsolidohet.",
    },
    { window: PM_CONTINUATION, windowMode: "ADVISORY" }),

  M(15, "LRLR", "Low Resistance Liquidity Run",
    ["low resistance liquidity run", "lrlr", "low resistance run"],
    {
      trigger: "Konfirmim se BSL (për Long) ose SSL (për Short) është marrë dhe rruga është e pastër.",
      validation: "Mungesa e opozitës në strukturën e afërt.",
      invalidation: "Shfaqja e një PDA të fortë kundërshtare.",
    },
    { timeStopBars: 18 }),

  M(16, "HIGH_RESISTANCE", "High Resistance Conditions",
    ["high resistance", "high resistance conditions", "hrc", "chop filter"],
    {
      trigger: "Sinjale kontradiktore — ky nuk është model hyrjeje, është filtër.",
      validation: "NUK KA ENTRY. Sinjali bllokohet automatikisht — PASS.",
      invalidation: "N/A — asgjë nuk hyhet, ndaj asgjë nuk invalidohet.",
    },
    // The one model whose content is a refusal. Registering it as a watch
    // would be the monitor agreeing to look for an entry the model says
    // does not exist, so it is refused at the door instead.
    { tradable: false }),

  M(17, "VENOM", "Venom Model",
    ["venom", "venom model", "sibi bisi"],
    {
      trigger: "Shfaqja e SIBI (fang 1) e ndjekur nga BISI (fang 2).",
      validation: "Entry kur çmimi kthehet ≤ mbylljes së BISI.",
      invalidation: "Dështimi i BISI-t për të mbajtur çmimin.",
    },
    { defence: "rejection_displacement", invalidationRule: "body_close" }),

  M(18, "JUDAS_SWING", "Judas Swing Entry",
    ["judas", "judas swing", "judas swing entry"],
    {
      trigger: "Sweep i njërës anë të Asian Range pas hapjes së Midnight Open.",
      validation: "Revers i menjëhershëm drejt anës së kundërt të range-it.",
      invalidation: "Vazhdimi i lëvizjes në drejtim të sweep-it (false reversal).",
    },
    { window: JUDAS_WINDOW, windowMode: "ADVISORY", defence: "rejection_displacement", timeStopBars: 9 }),

  M(19, "CISD", "CISD Entry",
    ["cisd", "cisd entry", "change in state of delivery"],
    {
      trigger: "Thyerja e çeljes (Open) të qiririt para displacement.",
      validation: "OB bëhet i vlefshëm dhe respektohet në ri-testim.",
      invalidation: "Mbyllje e trupit jashtë nivelit CISD.",
    },
    { invalidationRule: "body_close" }),

  M(20, "BREAKER_BLOCK", "Breaker Block Entry",
    ["breaker block", "breaker block entry", "breaker entry", "breaker"],
    {
      trigger: "Çmimi kthehet te Breaker Block pas strukturës High-Low-Higher High (ose anasjelltas).",
      validation: "Respektimi i Breaker Precedence Rule (nuk thyhet).",
      invalidation: "Thyerja e Breaker Block (Breaker invalidohet).",
    },
    { invalidationRule: "body_close" }),

  M(21, "SUSPENSION_BLOCK_INVERSION", "Suspension Block Inversion Entry",
    ["suspension block", "suspension block inversion", "suspension inversion"],
    {
      trigger: "Wick depërton Suspension Block, por trupi mbyllet jashtë tij, i shoqëruar me displacement.",
      validation: "CE vepron si kufi i fortë (hard boundary).",
      invalidation: "Mbyllje e trupit të qiririt pastër mbi/nën CE.",
    },
    { defence: "rejection_displacement", invalidationRule: "body_close" }),

  M(22, "PO3_DISTRIBUTION", "Power of 3 (PO3) Distribution Entry",
    ["po3", "power of 3", "power of three", "po3 distribution"],
    {
      trigger: "Kalimi nga fazat e Accumulation dhe Manipulation te faza e Distribution.",
      validation: "Çmimi largohet me shpejtësi nga zona e manipulimit.",
      invalidation: "Kthimi i çmimit brenda kutisë së manipulimit.",
    },
    { invalidationRule: "body_close", timeStopBars: 24 }),

  // ---------------------------------------------------------------------
  // The repo's own 19-model list, carried across whole.
  //
  // The two catalogues agree on 1, 2 and 3 and then diverge: the old
  // list's #4 is Silver Bullet where v6.0's is Turtle Soup, and from
  // there every number means two different things. Renumbering the old
  // list into this one would have silently changed what a setup written
  // against it means, and deleting the models it has that v6.0 does not
  // — OB+FVG, Unicorn, RIFVG, MMXM/MMBM and the rest — would leave the
  // monitor unable to name a setup the analyst is entitled to send.
  //
  // So they keep their own identities and take numbers after 22. A setup
  // names them the same way it names any other: by name. `catalogue`
  // says which list an entry came from, so the ambiguity is visible
  // rather than resolved by guesswork.

  M(23, "OB_FVG_CONFLUENCE", "OB + FVG Confluence",
    ["ob fvg confluence", "ob fvg", "ob plus fvg", "confluence ob fvg"],
    {
      trigger: "OB i identifikuar (CISD anchor) me një FVG që shtrihet prej tij — overlap gjeografik në të njëjtin nivel; çmimi kthehet te CE e FVG-së brenda OB-së.",
      validation: "Çmimi respekton CE-në e FVG-së brenda OB-së, pa e kaluar kufirin e OB-së.",
      invalidation: "Mbyllje e trupit nën/mbi OB — OB-ja thyhet dhe konfluenca shuhet.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(24, "UNICORN", "Unicorn (2nd Stage Redistribution)",
    ["unicorn", "second stage redistribution", "2nd stage redistribution"],
    {
      trigger: "MMXM/MMBM ka kaluar në 2nd Stage: faza e parë mbyllet me volume contraction dhe e dyta nis me displacement masiv.",
      validation: "FVG e 2nd Stage respektohet — shpejtësi dhe magnitudë maksimale në drejtimin e ri.",
      invalidation: "Çmimi kthehet brenda ekstremeve të 1st Stage — displacement-i dështoi.",
    },
    { defence: "rejection_displacement", timeStopBars: 9 }, "hybrid-v7.2"),

  M(25, "RIFVG", "RIFVG (Reaper Inversion FVG)",
    ["rifvg", "reaper inversion fvg", "reaper inversion"],
    {
      trigger: "Inversion FVG brenda Breaker leg — bullish: FVG në discount të Bullish Breaker; bearish: mirror.",
      validation: "Wick depërton RIFVG-në, trupi respekton 50% e range-it të ditës së kaluar.",
      invalidation: "Mbyllje e trupit përtej RIFVG-së — inversioni dështoi.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(26, "MMXM_MMBM", "MMXM / MMBM Full (Market Maker Models)",
    ["mmxm", "mmbm", "market maker model", "mmxm mmbm"],
    {
      trigger: "Cikli i plotë 4-fazësh arrin te FVG e 2nd Stage pas polarity flip-it.",
      validation: "Polarity flip i konfirmuar dhe CE e FVG-së së 2nd Stage respektohet.",
      invalidation: "Çmimi thyen ekstremet e 1st Stage — cikli nuk qëndron.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(27, "BISI_SIBI", "BISI / SIBI (Volume Imbalance Entry)",
    ["bisi", "sibi", "volume imbalance entry", "bisi sibi"],
    {
      trigger: "Çmimi depërton një BISI (ose SIBI) të pambushur — inefficiency që pret delivery-n e munguar.",
      validation: "Reagim brenda imbalance-it, pa mbyllje trupi përtej tij.",
      invalidation: "Mbyllje e trupit përtej imbalance-it — inefficiency u konsumua.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(28, "VAULT_POCKET", "Vault Pocket (Inner OB)",
    ["vault pocket", "inner ob", "vault"],
    {
      trigger: "Çmimi rikthehet te një OB i brendshëm brenda dealing range — jo te kufiri i tij.",
      validation: "Respektim i CE-së së OB-së së brendshme.",
      invalidation: "Mbyllje e trupit përtej OB-së.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(29, "SDR", "SDR (Standard Deviation Rejection)",
    ["sdr", "standard deviation rejection", "sd rejection"],
    {
      trigger: "Asian Range i identifikuar në M5; çmimi arrin projeksionin 1.0σ ose 1.5σ.",
      validation: "Rejection te niveli SD me wick ≥ 3× trupi.",
      invalidation: "Mbyllje e trupit përtej projeksionit SD.",
    },
    { defence: "rejection_displacement", invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(30, "DRO", "DRO (Daily Range Open)",
    ["dro", "daily range open", "gap fill open"],
    {
      trigger: "Gap i dukshëm në open të ditës; çmimi kthehet te open-i ose te 50% e gap-it.",
      validation: "Reagim te open-i ose te 50% e gap-it.",
      invalidation: "Çmimi kalon open-in me trup dhe vazhdon — gap-i nuk mbushet.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(31, "LSS", "LSS (Liquidity Sweep Setup)",
    ["lss", "liquidity sweep setup", "sweep mss"],
    {
      trigger: "Pool i identifikuar (BSL/SSL) → sweep i konfirmuar → MSS me displacement.",
      validation: "FVG e MSS-së respektohet në ri-testim.",
      invalidation: "Struktura kthehet — MSS-ja anulohet me mbyllje trupi.",
    },
    {}, "hybrid-v7.2"),

  M(32, "OSST", "OSST (One-Shot Setup)",
    ["osst", "one shot setup", "one-shot"],
    {
      trigger: "Të gjitha kushtet A+ janë prezente njëkohësisht: HTF alignment i fortë, Collection Grade A, displacement masiv, 3+ PDA confluence.",
      validation: "Një hyrje e vetme, pa retries. Target i plotë pa ndarje R1/R2.",
      invalidation: "Çdo kusht A+ që bie — setup-i vdes dhe nuk ka përpjekje të dytë.",
    },
    {}, "hybrid-v7.2"),

  M(33, "STRC", "STRC (Structure + CSD)",
    ["strc", "structure csd", "propulsion block", "change in state of delivery block"],
    {
      trigger: "CSD: çmimi tregton nën Open-in e qirit të fundit up-close (Bear Shoulder Block), ose mirror për bullish.",
      validation: "Propulsion Block aktivizohet dhe respektohet në ri-testim.",
      invalidation: "Mbyllje e trupit përtej Propulsion Block-ut.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),

  M(34, "SRT", "SRT (Sweep-Retest-Trap)",
    ["srt", "sweep retest trap", "sweep retest"],
    {
      trigger: "Sweep i konfirmuar → çmimi kthehet te niveli i sweep-uar (retest) → formohet trap pattern.",
      validation: "Trap pattern konfirmohet — p.sh. lower high pastaj break.",
      invalidation: "Çmimi kalon nivelin e sweep-uar pa trap — retest-i u shndërrua në continuation.",
    },
    { defence: "rejection_displacement" }, "hybrid-v7.2"),

  M(35, "FBE", "FBE (Fibo-Body-Entry)",
    ["fbe", "fibo body entry", "fibo body"],
    {
      trigger: "Zona Fibo OTE 0.618–0.79 përputhet me një PDA array dhe çmimi e arrin atë.",
      validation: "Mbyllje e TRUPIT — jo wick — brenda zonës Fibo.",
      invalidation: "Mbyllje e trupit përtej zonës Fibo.",
    },
    { invalidationRule: "body_close" }, "hybrid-v7.2"),
]);

/**
 * Names that identify a family rather than a model. "Silver Bullet" is
 * three models with three different hours; "Opening Range" is two.
 *
 * A setup that names one of these without saying which gets NO policy —
 * not a guess, and not whatever a number from the other catalogue would
 * have said. Monitoring a PM Silver Bullet against the London window
 * would refuse every entry for two hours and then expire the setup, and
 * it would do it while quoting a model the analyst never wrote.
 */
const AMBIGUOUS_NAMES = Object.freeze(["silver bullet", "opening range", "sb"]);

const BY_NUMBER = new Map(ENTRY_MODELS.map((model) => [model.number, model]));
const BY_KEY = new Map(ENTRY_MODELS.map((model) => [model.key, model]));

export function entryModelByNumber(number) {
  return BY_NUMBER.get(Number(number)) || null;
}

export function entryModelByKey(key) {
  return BY_KEY.get(String(key || "").toUpperCase()) || null;
}

/**
 * Resolve the analyst's free text to one model, or to nothing.
 *
 * Nothing is a legitimate answer and is never an error: a setup whose
 * model the monitor cannot name still has levels, and refusing it would
 * make an unrecognised label more destructive than no label at all. It
 * simply gets no model policy.
 */
export function resolveEntryModel(value) {
  const text = normaliseModelText(value);
  if (!text) return null;

  const keyed = entryModelByKey(text.replace(/ /g, "_"));
  if (keyed) return { model: keyed, matchedBy: `key:${keyed.key}` };

  let best = null;
  for (const model of ENTRY_MODELS) {
    for (const alias of model.aliases) {
      if (!alias || !text.includes(alias)) continue;
      // Longest alias wins, so "silver bullet pm" beats "silver bullet".
      if (!best || alias.length > best.alias.length) best = { model, alias };
    }
  }

  const numbered = /(?:^|\b)(?:model|modeli)\s*(?:nr\s*)?#?\s*(\d{1,2})(?:\b|$)/.exec(text);
  const leading = /^(\d{1,2})\b/.exec(text);
  const explicit = numbered?.[1] ?? leading?.[1];
  const byNumber = explicit === undefined ? null : entryModelByNumber(explicit);

  // When a number and a name disagree, the NAME wins.
  //
  // Two catalogues live here and they agree only on 1, 2 and 3: "Model 4"
  // is Silver Bullet in the older list and Turtle Soup in v6.0, and every
  // number after that means two different things. A name never collides
  // that way — there is exactly one Silver Bullet — so "Model 4 — Silver
  // Bullet" resolves to Silver Bullet rather than quietly monitoring a
  // Turtle Soup against a Silver Bullet's window.
  //
  // A bare number with no name still resolves, and resolves against the
  // v6.0 numbering: that is the catalogue the analysis prompt writes to.
  if (best && byNumber && best.model.number !== byNumber.number) {
    return { model: best.model, matchedBy: `alias:${best.alias} (number ${byNumber.number} disagreed)` };
  }
  // A family name with nothing to disambiguate it beats the number too:
  // the text says Silver Bullet, so resolving it to Turtle Soup because
  // "4" is there would name a model the analyst did not write.
  if (!best && AMBIGUOUS_NAMES.some((name) => new RegExp(`(^| )${name}( |$)`).test(text))) {
    return null;
  }
  if (byNumber) return { model: byNumber, matchedBy: `number:${byNumber.number}` };
  return best ? { model: best.model, matchedBy: `alias:${best.alias}` } : null;
}

/**
 * Where the clock is relative to a model's window. `BEFORE` and `AFTER`
 * are kept apart on purpose: before the window the setup is waiting and
 * everything is fine; after it, a Silver Bullet is over.
 */
export function modelWindowState(model, nowMs = Date.now()) {
  const window = model?.policy?.window;
  if (!window) return { state: "NONE", window: null };
  const { minutes } = nyClock(nowMs);
  if (isWindowActive(minutes, window)) return { state: "OPEN", window };
  const start = toMinutes(window.start);
  const end = toMinutes(window.end) === 0 ? 1440 : toMinutes(window.end);
  // A window that wraps midnight is never "after" within the same day.
  if (start > end) return { state: "BEFORE", window };
  return { state: minutes < start ? "BEFORE" : "AFTER", window };
}

export function modelDayState(model, nowMs = Date.now()) {
  const days = model?.policy?.days;
  if (!days) return { allowed: true, days: null, weekday: nyClock(nowMs).weekday };
  const { weekday } = nyClock(nowMs);
  return { allowed: days.includes(weekday), days, weekday };
}

/**
 * How many closed M5 bars this setup gets to start working before the
 * Time Stop calls it a Time Distortion. Outside a kill zone the clock
 * runs at half length: the master prompt's own reason for the rule is
 * that a setup drifting outside the institutional hours is not being
 * delivered, it is just sitting there.
 */
export function timeStopBarsFor(model, { killZoneActive = true, override = null } = {}) {
  const base = Number.isFinite(override) && override > 0
    ? Math.floor(override)
    : (model?.policy?.timeStopBars ?? DEFAULT_TIME_STOP_BARS);
  if (killZoneActive) return base;
  return Math.max(4, Math.ceil(base / 2));
}

/**
 * The live gate. Everything it can block is something that may become
 * true later, so a blocked model withholds the entry and keeps watching;
 * only `expired` is terminal, and only for a model that says its own
 * window closing is an invalidation.
 */
export function evaluateModelGate(model, { nowMs = Date.now(), direction = null } = {}) {
  const blockers = [];
  const notes = [];
  if (!model) return { pass: true, expired: false, blockers, notes, window: { state: "NONE", window: null } };

  const window = modelWindowState(model, nowMs);
  const day = modelDayState(model, nowMs);

  if (model.policy.directions && direction && !model.policy.directions.includes(direction)) {
    blockers.push({
      code: "MODEL_DIRECTION",
      detail: `Modeli ${model.number} (${model.name}) lejon vetëm ${model.policy.directions.join("/").toUpperCase()}`,
    });
  }
  if (!day.allowed) {
    const message = `Modeli ${model.number} kërkon ${day.days.join("/")} — sot është ${day.weekday}`;
    if (model.policy.windowMode === "ADVISORY") notes.push(message);
    else blockers.push({ code: "MODEL_DAY", detail: message });
  }
  if (window.state === "BEFORE" || window.state === "AFTER") {
    const label = `${window.window.name} ${window.window.start}–${window.window.end} NY`;
    const message =
      window.state === "BEFORE"
        ? `Dritarja e modelit ${model.number} (${label}) nuk ka hapur ende`
        : `Dritarja e modelit ${model.number} (${label}) është mbyllur`;
    if (model.policy.windowMode === "ADVISORY") notes.push(message);
    else blockers.push({ code: window.state === "BEFORE" ? "MODEL_WINDOW_PENDING" : "MODEL_WINDOW_CLOSED", detail: message });
  }

  return {
    pass: blockers.length === 0,
    // §5.1: for the three Silver Bullets the window closing is the
    // invalidation the model itself declares, not a wait.
    expired:
      window.state === "AFTER" &&
      model.policy.windowMode === "HARD" &&
      model.policy.windowCloseInvalidates === true,
    blockers,
    notes,
    window,
    day,
  };
}

/** The catalogue entry as the operator reads it, for Telegram and audit. */
export function describeEntryModel(model) {
  if (!model) return null;
  return {
    number: model.number,
    key: model.key,
    name: model.name,
    catalogue: model.catalogue,
    trigger: model.trigger,
    validation: model.validation,
    invalidation: model.invalidation,
    tradable: model.policy.tradable,
    directions: model.policy.directions,
    window: model.policy.window,
    days: model.policy.days,
    defence: model.policy.defence,
    invalidation_rule: model.policy.invalidationRule,
    time_stop_bars: model.policy.timeStopBars,
  };
}

/**
 * Attach the resolved model to a validated setup, and refuse the two
 * things that can never become true later.
 *
 * Called after `validateWatchInput`, not inside it, so the dependency
 * runs one way: this module knows about setups, `core` knows nothing
 * about the catalogue.
 *
 * Model defaults are applied only where the analyst declared nothing. A
 * declared `defence_profile` is the analyst's setup (§22) and the model
 * never overrides it — the catalogue fills a blank, it does not overrule
 * a choice.
 */
export function applyEntryModel(input, args = {}) {
  const resolved = resolveEntryModel(args.entry_model ?? input.setup_model);
  if (!resolved) {
    return { ...input, entry_model: null, entry_model_matched_by: null };
  }
  const { model, matchedBy } = resolved;

  if (model.policy.tradable === false) {
    throw new Error(
      `Modeli ${model.number} (${model.name}) është filtër, jo model hyrjeje — PASS. ` +
        `Sinjali u bllokua automatikisht dhe asnjë watch nuk u regjistrua.`,
    );
  }
  if (model.policy.directions && !model.policy.directions.includes(input.direction)) {
    throw new Error(
      `Modeli ${model.number} (${model.name}) lejon vetëm ` +
        `${model.policy.directions.join("/").toUpperCase()} — u dërgua ${input.direction.toUpperCase()}`,
    );
  }

  const declaredDefence = args.defence_profile !== undefined && args.defence_profile !== null && args.defence_profile !== "";
  const declaredRule = args.invalidation_rule !== undefined && args.invalidation_rule !== null && args.invalidation_rule !== "";
  return {
    ...input,
    defence_profile: declaredDefence ? input.defence_profile : model.policy.defence,
    invalidation_rule: declaredRule ? input.invalidation_rule : model.policy.invalidationRule,
    entry_model: describeEntryModel(model),
    entry_model_matched_by: matchedBy,
  };
}
