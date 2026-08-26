# 🧬 13 · SMT ENGINE — Smart Money Divergence (live)

> Detektori i divergjencës mes aseteve të korreluara. Përgjigjet një pyetjeje
> të vetme: **a po e konfirmon aseti i korreluar lëvizjen strukturore të asetit
> kryesor, apo po e mohon?**
>
> **SMT ≠ korrelacion.** Korrelacioni është drejtimi statistikor mes dy aseteve.
> SMT është **divergjenca e marrjes së likuiditetit në të njëjtën dritare kohore**
> — dhe pikërisht ajo divergjencë është konfirmimi institucional i kurthit.

**Pse ekziston ky skedar:** monitori e llogarit SMT-në live dhe **e numëron si
provë të fortë** kur vendos nëse jep `ENTER NOW`. Deri tani skilli nuk e lexonte
në të njëjtën mënyrë. Ky skedar e mbyll atë hendek: më poshtë është saktësisht
ajo që kodi bën, jo një përshkrim paralel.

---

## 1 · BUNDLE-t (siç i ka monitori vërtet)

```python
SMT_BUNDLES = {
    "XAUUSD": [("XAGUSD", direct), ("EURUSD", inverse)],
    "XAGUSD": [("XAUUSD", direct), ("EURUSD", inverse)],
    "BTCUSD": [("ETHUSD", direct)],
    "ETHUSD": [("BTCUSD", direct)],
    "USTEC":  [("US500", direct), ("US30", direct)],
    "US30":   [("US500", direct), ("USTEC", direct)],
    "US500":  [("USTEC", direct), ("US30", direct)],
    "NAS100": [("US500", direct)],
    "SPX500": [("USTEC", direct)],
    "EURUSD": [("GBPUSD", direct)],
    "GBPUSD": [("EURUSD", direct)],
}
```

### 1.1 · Pse jo DXY

Në këtë connector **nuk ka DXY të përdorshëm** — çdo `DXY_*` është kontratë e
datuar dhe e çaktivizuar. Zëvendësuesit:

| Proxy | Pse funksionon | Këmba |
|---|---|---|
| **EURUSD** *(inverse)* | EUR është ~57.6% e shportës DXY; drejtimi i EURUSD ≈ i kundërti i DXY | dollari |
| **XAGUSD** *(direct)* | Argjendi dhe ari lëvizin me të njëjtat flukse institucionale | metali |

⚠️ Nëse ndonjë referencë e vjetër të thotë të përdorësh `DXY` për XAUUSD —
është gabim. Simboli nuk zgjidhet dot dhe leximi del `UNAVAILABLE`.

---

## 2 · SI E LLOGARIT MONITORI (saktësisht)

- **Timeframe:** vetëm **M5**. Jo H1, jo M15.
- **Dritarja:** 20 qirinj të mbyllur; dy të fundit përjashtohen nga dritarja e
  swing-ut dhe përdoren si "a u mor niveli tani".
- **Seritë rreshtohen sipas kohës së qirinjve**, kurrë sipas pozicionit në
  varg — një qiri që mungon te partneri nuk zhvendos krahasimin.

### 2.1 · Rregulli — divergjencë e marrjes së likuiditetit

Për një **buy**:

```
1. A e mori vetë aseti kryesor low-in e vet të fundit (20 qirinj) në 2 qirinjtë e fundit?
   JO  → SMT = false. Nuk ka divergjencë për të lexuar. NDAL.
   PO  → vazhdo.

2. A e mori partneri nivelin e vet përkatës?
   direct  (XAGUSD): a e mori low-in e vet?
   inverse (EURUSD): a e mori high-un e vet?

   JO e mori → SMT = true  → DIVERGJENCË
   PO e mori → SMT = false → KONFLUENCË
```

Për një **sell** është pasqyra: kryesori merr high-un e vet; partneri direct
duhet të marrë high-un, ai inverse duhet të marrë low-in.

**Vini re rendin:** pa marrje likuiditeti nga vetë aseti kryesor, nuk ka SMT
fare. SMT nuk është "dy asete që lëvizin ndryshe" — është "kryesori mori
likuiditet, partneri nuk e konfirmoi".

### 2.2 · Tri vlera, jo dy

| Vlera | Kuptimi | Çfarë bën monitori |
|---|---|---|
| `true` | divergjencë e konfirmuar | provë e fortë, hyn te makina e evidencës |
| `false` | u lexua dhe nuk ka divergjencë | asnjë provë |
| `null` | **nuk u lexua dot** (partneri mungon, pak qirinj) | **asgjë — nuk lexohet si `false`** |

`null` nuk është mungesë divergjence. Është mungesë leximi. Monitori e mban
slot-in e evidencës në vend që ta zbrazë — një partner që nuk u mor dot nuk
është provë për asgjë.

---

## 3 · KUSH ËSHTË NË KURTH (trapped party)

Kur SMT = `true`, swing-u i asetit kryesor është **këmba e rreme**:

> XAU bën low më të ulët, XAG nuk e bën → shitësit e XAU janë në kurth,
> XAG është e vërteta.

Kjo ushqen drejtpërdrejt Trap Engine (§04): `trapped_party = MAIN_LEG`.
Kur SMT = `false`, të dyja këmbët pajtohen → nuk ka manipulim të dukshëm →
`trapped_party = None`.

---

## 4 · SI E PËRDOR SKILLI

SMT-ja hyn te vlerësimi im i conviction-it, jo te fushat që i dërgoj monitorit.
**Monitori e llogarit vetë live** — unë nuk ia dërgoj dot dhe nuk duhet të
provoj.

| SMT në analizën time | Efekti te `ilos_state.confidence` |
|---|---|
| DIVERGJENCË + kurthi i identifikuar | mbështet `HIGH` |
| DIVERGJENCË pa kurth të pastër | mbështet `MEDIUM` |
| KONFLUENCË | asnjë ndryshim — lëvizje e shëndoshë, jo kurth |
| Partneri konfliktual | ul conviction-in te `LOW` ose më mirë: pa setup |
| `UNAVAILABLE` | asnjë ndryshim. Mungesa e leximit nuk është as pro as kundër |

**SMT nuk bllokon kurrë analizën.** Nëse partneri nuk zgjidhet, vazhdo pa të
dhe shënoje te `warnings`, mos e ndal setup-in.

---

## 5 · ÇFARË NUK BËN KY ENGINE

- Nuk shpik qirinj që nuk u kthyen nga MCP.
- Nuk e lexon `null` si `false`.
- Nuk përdor DXY.
- Nuk e bën SMT-në kusht të detyrueshëm për hyrje — është një nga provat që
  monitori mund të gradojë, jo porta.
- Nuk e krahason asetin kryesor me një partner që nuk u rreshtua dot në kohë.

---

## 6 · OUTPUT

```json
"smt": {
  "bundle": ["XAGUSD", "EURUSD(inverse)"],
  "signal": "DIVERGENT|CONFLUENT|NEUTRAL|UNAVAILABLE",
  "main_took_liquidity": true,
  "partner_confirmed": false,
  "trapped_party": "MAIN_LEG|null",
  "note": "XAU mori low-in e M5; XAG nuk e mori"
}
```

→ Kontrata e plotë e output-it: [11-output-schema.md](11-output-schema.md)
