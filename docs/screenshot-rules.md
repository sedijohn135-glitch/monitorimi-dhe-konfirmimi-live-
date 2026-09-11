# Rregullat nga 8 screenshot-et — ku ndodhen në kod

Operatori dërgoi tetë chart-e reference. Ky dokument thotë, për secilin,
çfarë kërkonte dhe cila pjesë e kodit e bën — ose pse nuk e bën.

Asnjë prej tyre nuk është portë. Sekuenca e konfirmimit (rejection →
ndryshim strukture → displacement → acceptance) vendos nëse hyhet; këto
përshkruajnë **sa mirë** u mbajt setup-i dhe shkruhen te mesazhi i hyrjes.

| # | Screenshot-i | Ku është |
|---|---|---|
| 1 | Bullish / Bearish Engulfing | `classifyEngulfing` — M5 dhe M1, te sinjalet e konfirmimit |
| 1 | Hanging Man (wick i gjatë) | `classifyWick` — matet kundrejt ATR, jo me sy |
| 1 | Three White Soldiers / Black Crows | **`sequentialDrive`** — i ri |
| 2 | Buyers Power (trupa që zvogëlohen) | **`momentumFade`** — i ri |
| 3 | Break of Structure | `structureBreaks`, `checkMSS` — mbyllje trupi mbi një pivot të vërtetë |
| 3 · 8 | Fibo 0.618 / 0.79 | **`oteZone`, `inOteZone`** — i ri |
| 4 | Lokacioni përcakton forcën | `premiumDiscount`, `pdaConfluence` |
| 6 | FVG në displacement leg, SL nën swing | `fairValueGaps`, `displacementBars`, `findSwing` — kjo është vetë hyrja ICT 2022 |
| 7 | Stop hunt → hyr pas rejection | `checkZoneRejection` + i gjithë krahu Anti-SL |
| 8 | Struktura e tregut (HH/HL) | `strictSwings` — rregulli i rreptë 3-qirinjsh |
| 5 | "Mos u fokuso 10→100" | psikologji, jo kod |
| 8 | Nivele psikologjike, trendline | i lexon analiza; nivelet vijnë me setup-in |

## Tre leximet e reja

**`momentumFade(bars, direction)`** — a po zvogëlohen trupat e qirinjve që
shtyjnë *kundër* trade-it? Kjo është "zbehja e volumit" e Modelit 9 dhe
bishti i stage-imit të Modelit 11, e matur mbi trupa e jo mbi volum:
volumi tick i një CFD-je përshkruan fluksin e brokerit, trupi përshkruan
delivery-n — dhe vetëm njëri prej tyre është tregu.

**`sequentialDrive(bars, direction)`** — tre mbyllje radhazi në drejtimin e
trade-it, ku secila hapet **brenda** trupit të mëparshme dhe mbyllet përtej
saj. Rregulli "hapet brenda" është ai që e ndan modelin nga tre qirinj që
thjesht kanë të njëjtën ngjyrë.

**`oteZone(bars, direction)`** — brezi 0.618–0.79 i leg-ut, i matur nga
swing-et që monitori tashmë i llogarit, jo nga çfarë pohon analiza. Pra
është lexim i pavarur i të njëjtit chart: përputhja do të thotë që dy
derivime ranë në të njëjtin brez, mospërputhja vlen ta shohësh para se të
hysh.

## Si duket te Telegram-i

```
🚨 HYR TANI — REAL CONFIRMATION
Symbol: XAUUSD
Direction: SHORT
Modeli: 7 · Silver Bullet (AM 10-11 AM)
Validimi: BMS paraprak në drejtimin e dëshiruar + FVG e paprekur
Invalidimi: Mbyllja e dritares kohore ose thyerja e FVG-së
Kualiteti: momentum kundër po shuhet · entry brenda OTE 0.618–0.79
...
```

Rreshti `Kualiteti` shfaqet vetëm kur ka diçka për të thënë. Mungesa e tij
nuk është refuzim — hyrja kaloi çdo portë para se ai rresht të shkruhej.

## Pse raportim dhe jo portë

Një portë këtu do të refuzonte hyrje që analiza i kishte parasysh, dhe kjo
është forma e dështimit që kushton më shumë e duket më pak: **një hyrje që
nuk ndizet kurrë duket saktësisht si një treg që nuk erdhi kurrë.**

E njëjta arsye pse dritarja e Opening Range u bë shënim dhe jo bllokim.
