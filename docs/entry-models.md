# 22 modelet e hyrjes dhe 4 kill switch-at

Katalogu i MULTISNIPER07 v6.0, i shkruar ashtu që monitori të mund të
veprojë mbi të — jo vetëm ta printojë emrin e modelit.

Kodi: [`lib/entry-models.mjs`](../lib/entry-models.mjs) dhe
[`lib/kill-switch.mjs`](../lib/kill-switch.mjs). Cikli i plotë i setup-it
mbetet ai i [`setup-lifecycle.md`](setup-lifecycle.md) — ky dokument shton
vetëm atë që varet nga **cili model** është dhe **çfarë e vret**.

## Çfarë kontrollon makina dhe çfarë jo

Trigger-i i vërtetë i një modeli — "FVG pas një sweep dhe një BOS" —
lexohet nga analiza në chart dhe mbërrin si nivelet e vetë setup-it. Ai nuk
ri-derivohet këtu; do të ishte mendim i dytë që konkurron me të parin.

Mbetet ajo që analiza **nuk mund ta dijë kur e shkruan setup-in**, sepse
varet nga *kur mbërrin çmimi*:

| Fusha | Kur vendos | Sjellja |
|---|---|---|
| `tradable` | regjistrim | Model 16 = PASS, refuzohet në derë |
| `directions` | regjistrim | Model 2 vetëm LONG, Model 11 vetëm SHORT |
| `window` | çdo tik | dritarja e sesionit NY — mban hyrjen jashtë saj |
| `days` | çdo tik | dita e javës (vetëm Model 3) |
| `defence` | regjistrim | mbush `defence_profile` vetëm nëse analisti nuk e deklaroi |
| `invalidationRule` | regjistrim | `body_close` vs `touch`, po ashtu vetëm si default |
| `timeStopBars` | pas hyrjes | sa qirinj M5 ka setup-i për të nisur punën |

Dy refuzime ndodhin në regjistrim sepse **nuk mund të bëhen kurrë të
vërteta më vonë**. Gjithçka tjetër është portë e gjallë: e mban hyrjen sa
kohë është false dhe e lëshon kur bëhet true — saktësisht si porta e Kill
Zone-s dhe e lajmeve që ekzistojnë tashmë.

Një emër modeli që nuk njihet nuk është gabim: setup-i mbetet me nivelet e
veta dhe thjesht nuk merr asnjë politikë modeli.

## Katalogu

| # | Modeli | Trigger | Validation | Invalidation | Politika e makinës |
|---|---|---|---|---|---|
| 1 | ICT 2022 Model | FVG pas sweep SSL/BSL + BOS në LTF | trup mbyllet brenda FVG | trup jashtë ekstremit të strukturës | body_close · 18 qirinj |
| 2 | Market Anchor | sweep ATH + Inversion FVG | trupi brenda anchor-it | trup thyen anchor-in | **vetëm LONG** · body_close |
| 3 | Model 2 Amplified | Mar/Mër 06:00 NY, PDA mujore/javore | rejection me wick në PDA | thyerje e plotë e PDA javore | Mar/Mër · 06:00–10:00 · rejection+displacement |
| 4 | Turtle Soup | sweep i Old H/L + largim i shpejtë | qiri displacement i kundërt | vazhdim pa kthim | rejection+displacement · 9 qirinj |
| 5 | Turtle Soup Deferred | retest i PDA pas stop hunt | wick brenda PDA, trup jashtë | trup mbyllet brenda PDA | rejection+displacement · body_close |
| 6 | Silver Bullet London | FVG brenda 03:00–04:00 NY | BMS paraprak + FVG e paprekur | mbyllja e dritares ose thyerje e FVG | **dritarja e mbyllur = invalidim** · 6 qirinj |
| 7 | Silver Bullet AM | FVG brenda 10:00–11:00 NY | njësoj | njësoj | njësoj |
| 8 | Silver Bullet PM | FVG brenda 14:00–15:00 NY | njësoj | njësoj | njësoj |
| 9 | OTE | pas BOS, tërheqje 0.618–0.79 | rejection në Fibo + zbehje volumi | kalim i 0.79/1.0 | rejection+displacement |
| 10 | IOFED | FVG e re brenda FVG-së origjinale | 50% CE e FVG-së së brendshme | thyerje e kufirit të jashtëm | body_close |
| 11 | Smart Money 3-Stage (ATH) | 3 faza shpërndarjeje në ATH | asnjë trup mbi CE | trup mbyllet mbi CE | **vetëm SHORT** · body_close |
| 12 | Opening Range FPFVG (AM) | FVG e parë pas OR 07:00–07:30 | displacement i qartë | thyerje e kufirit të kundërt të OR | 07:30–12:00 · rejection+displacement |
| 13 | Opening Range FPFVG (PM) | FVG e parë pas OR 13:30–14:00 | displacement i qartë | njësoj | 14:00–16:00 · rejection+displacement |
| 14 | NY Lunch Macro → PM | pas 13:00, target i identifikuar në 10:00 | FVG në PM drejt targetit | targeti mblidhet, çmimi konsolidon | 13:00–16:00 |
| 15 | Low Resistance Liquidity Run | BSL/SSL e marrë, rrugë e pastër | mungesë opozite pranë | shfaqet PDA e fortë kundërshtare | 18 qirinj |
| 16 | High Resistance Conditions | sinjale kontradiktore | **NUK KA ENTRY — PASS** | N/A | **refuzohet në regjistrim** |
| 17 | Venom | SIBI (fang 1) → BISI (fang 2) | entry ≤ mbylljes së BISI | BISI dështon ta mbajë çmimin | rejection+displacement · body_close |
| 18 | Judas Swing | sweep i Asian Range pas Midnight Open | revers i menjëhershëm | vazhdim në drejtim të sweep-it | 00:00–10:00 (këshillues) · 9 qirinj |
| 19 | CISD | thyerje e Open-it para displacement | OB i vlefshëm, respektohet | trup jashtë nivelit CISD | body_close |
| 20 | Breaker Block | kthim te Breaker pas H-L-HH | Breaker Precedence respektohet | Breaker thyhet | body_close |
| 21 | Suspension Block Inversion | wick depërton, trup jashtë + displacement | CE si kufi i fortë | trup mbyllet pastër mbi/nën CE | rejection+displacement · body_close |
| 22 | Power of 3 Distribution | kalim Manipulation → Distribution | largim i shpejtë nga manipulimi | kthim brenda kutisë së manipulimit | body_close · 24 qirinj |

## Gjendjet — çfarë sheh operatori dhe çfarë ndjek monitori

Skema me 5 gjendje e kërkesës është pamja e operatorit. Makina e brendshme
është më e gjatë sepse *ENTRY_TOUCHED* dhe *ENTRY_CONFIRMED* nuk janë e
njëjta gjë, dhe ngatërrimi i tyre është pikërisht mënyra si hyhet në një
trade që nuk ekziston më:

| Operatori | Gjendjet reale ([setup-lifecycle](setup-lifecycle.md)) | Njoftimi |
|---|---|---|
| PENDING_ENTRY | `READY_FOR_ENTRY` → `ENTRY_TOUCHED` | "CONFIRMED — WAIT FOR THE ZONE" |
| ACTIVE_TRADE | `REJECTION_DETECTED` → `M5_MSS_CONFIRMED` → `DISPLACEMENT_CONFIRMED` → `ENTRY_CONFIRMED` | **🚨 HYR TANI** + modeli, validimi, invalidimi |
| TP1 / BE | `TP1` në regjistrimin e trade-it | **✅ TP1 ARDHI** + urdhri për Break-Even |
| TP2 / TP3 | `TP2` / `TP3` | **🎯 TP2 ARDHI** |
| SL / INVALID | `TRADE_STOPPED` · `INVALIDATED` · `EXPIRED` | **❌ SL HIT** (ose BREAK-EVEN STOP) |

**TP1 → Break-Even:** monitori zhvendos vetë `sl` te `entry` dhe e ruan të
vjetrin si `plannedSl`. Ai **nuk ka urdhër te brokeri** për një pozicion
manual, ndaj njoftimi e thotë hapur: lëvize edhe ti te brokeri. Nëse më pas
preket ai stop, mesazhi e quan *BREAK-EVEN STOP*, jo humbje — përndryshe
dita do të lexohej gabim kur t'i shohësh njoftimet prapa.

## Kill switch-at

Katër mënyra si një trade është tashmë i vdekur ndërsa çmimi është ende
larg stop-it. Të katërt janë **rekomandim, jo veprim**: nuk ka urdhër
mbyllës pas një pozicioni manual, ndaj secili dërgon një mesazh kritik një
herë të vetme dhe trade-i vazhdon të ndiqet.

| Kodi | Armatoset nga | Fiket kur | Rregulli |
|---|---|---|---|
| `BREAKER_PRECEDENCE` | `breaker_level` | trup mbyllet përtej Breaker-it kundër pozicionit | §06.C / Iron Rule 15 |
| `HTF_CASCADE` | `htf_pda_level` | Daily PDA thyhet **pa** `htf_weekly_confirmed` | §06.E / Iron Rule 14 |
| `PDA_ARRAYS_BROKEN` | `pda_arrays` | 3 array mes entry dhe SL të thyera me trup | Iron Rule 12 |
| `TIME_STOP` | vetë modeli | N qirinj pas hyrjes me < 50% progres drejt TP1 | Time Distortion |

Tri veti vlejnë për të katërt:

1. **Asgjë nuk fiket mbi një nivel që askush nuk e deklaroi.** Një switch i
   paarmatosur raporton se është i paarmatosur dhe nuk numërohet kurrë si
   kalim — të shpikje një Breaker që rregulli pastaj ta kontrollojë do të
   ishte monitori duke fabrikuar provën mbi të cilën vepron.
2. **Gjithçka matet mbi trupa të mbyllur.** Wick përtej një Breaker-i është
   bastisje e stop-eve pas tij; mbyllje trupi është tregu që e pranon
   çmimin në anën tjetër.
3. **Një nivel në anën e gabuar refuzohet, nuk hiqet në heshtje.** Një
   Breaker mbi entry-n e një long-u nuk është Breaker-i që e mban atë long.

Një Daily PDA i thyer me Weekly pas tij **nuk** e vret tezën: raportohet si
cascade dhe bias-i nuk ndryshon. Kjo është e gjithë përmbajtja e Iron Rule
14, dhe është e vetmja arsye pse `htf_weekly_confirmed` ekziston.

## Fikja

| Env | Default | Çfarë fik |
|---|---|---|
| `ENTRY_MODEL_GATE_ENABLED` | `true` | i gjithë katalogu — modelet bëhen sërish thjesht etiketa |
| `KILL_SWITCHES_ENABLED` | `true` | të katër switch-at |
| `TIME_STOP_ENABLED` | `true` | vetëm Time Stop |
| `TIME_STOP_MIN_PROGRESS` | `0.5` | sa larg TP1 quhet "po dorëzohet" |
| `BREAK_EVEN_ON_TP1` | `true` | zhvendosjen e stop-it te entry në TP1 |
