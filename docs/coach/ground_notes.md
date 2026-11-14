# Forehand / backhand ground knowledge — decision notes

Data file: `ground_knowledge.json` (67 metrics, 28 players, 24 faults, 12 result→cause maps, 87 sources + `CALC`/`memory` tags).

**How far to trust it.** Page fetching was blocked in this session (pmc.ncbi.nlm.nih.gov, www.jssm.org not in the allowed
network domains) and the shared web-search budget ran out after ~95 searches. Every number comes from a search-result
summary or abstract snippet, not from a full-text table. `CALC` = my own ball-flight/impact simulation; `memory` = unverified.
Skeleton thresholds in `faults[].skeleton_sign` are heuristics to calibrate, not sourced values.

## 1. Contact point
- No peer-reviewed "forehand contact X cm in front" value was found. Coaching figures disagree because the reference point
  differs: 5–20 cm in front of the torso (Pat Cash), 30–46 cm in front of the lead hip (coaching guide), 20–40 cm in front of
  the hitting shoulder (app vendor), "slightly in front of the front knee; 40 cm ahead of the knee is too far" (Korean forum).
- Backhands: one-hander contact ≈ 0.59 m in front vs two-hander ≈ 0.40 m (secondary quote of Reid & Elliott 2002).
  Two-hander ≈ level with the front hip; one-hander clearly ahead of the front foot (~30 cm in a Korean write-up).
- Contact height: pro average 0.96 m (men) / 0.94 m (women) ≈ 0.52 × height. By grip: eastern knee–waist,
  semi-western waist–shoulder, western shoulder and above; western struggles on low balls.
- Arm structure follows grip: elbow ≈ 130° at impact with eastern, ≈ 100° with western (Elliott, via Reid 2013 review).
  Straight arm: Federer (mostly), Nadal, Alcaraz, del Potro, Verdasco. Bent: Sinner (verified), Djokovic (one source only).
  Two-hander top-arm elbow flexion at impact 61 ± 20° (eastern top hand) / 47 ± 20° (continental); one-hander arm straight.

## 2. Body positions
- Forehand turn: unit turn ≈ 45°, full turn ≥ 90° and typically 100–110° with the left arm stretched across (Yandell).
  Max shoulder–hip separation 27 ± 9° (ATP) and 33 ± 10° (national level; group labels inferred from a snippet) — no level difference.
- What separates levels is rotation speed and timing: pelvis 295 vs 168 °/s, trunk 453 vs 292 °/s at impact (Landlinger).
- At contact the shoulders are 45° to parallel to the net (forehand) but stay roughly side-on on the one-hander.
- Backswing shoulder alignment: one-hander 119°, two-hander 83°; forward acceleration starts 0.13 s vs 0.08 s before impact.
- Stance: 83.6% of pro forehands are open/semi-open (65% when there is time); square stance gives +4–6 km/h.
- Knees: only weak numbers (loading knee ≈ 113°, front knee 129–140°, one small study). Restricting knee motion cost 29%
  of racket speed in a model of 16 college players; harder shots use ~27% more knee flexion and ~28% more trunk rotation.

## 3. Net vs long (physics)
- Good topspin drive: path rising 20–30°, face 5–15° closed (Federer 11°, Nadal 15°, top-10 range 5–18°).
- Launch angle moves ≈ 1° per 1° of face but only ≈ 0.3° per 1° of path (CALC): face is ~3× more important.
- Vertical window (net to baseline, CALC, matches Brody's ~8° and his 43% shrink from 50→60 mph):
  70 km/h ≈ 20°, 80 km/h ≈ 13°, 100 km/h ≈ 7–8°, tour forehand (120 km/h, 2,700 rpm) ≈ 5.6°, 120 km/h flat ≈ 3°.
  So face tolerance is about ±6–10° at club pace and ±3° at tour pace; 1° of launch = 0.2–0.5 m of depth at club pace, ~1.2 m on tour.
- Depth at club pace needs height: at 70 km/h a ball clearing the net by the tour-average 0.7 m lands ~1.5 m short of the
  service line; landing near the baseline needs 2–3 m of clearance (launch 22–27°). Tour net clearance is 0.69 m (men) / 0.77 m (women).
- Speeds/spin: ATP forehand 117–126 km/h, 2,700–2,850 rpm; ATP backhand 106 km/h, 1,800–2,000 rpm; WTA top-100 forehand
  ≈ 115 km/h, ≈ 2,100 rpm; club (NTRP 2.5–5.0) forehand 66–78 km/h, backhand 64–73 km/h. Club rpm: no data found (memory: 500–1,500).
- Long errors have a racket path ~3° steeper than net errors; missed shots show more face-angle variability.

## 4. Early vs late contact
- Late (wrist level with/behind front hip or shoulder line, elbow jammed, trunk leaning back): ball goes right and short for a
  right-hander, or floats long when the face is still open. Too far in front (arm reaching, wrist rolling): net or pulled across.
- Do not hard-code one outcome per timing error — see "disagreements" below.

## 5. High and low balls
- From the baseline a knee-high ball must launch ~3° higher than a waist-high ball, a shoulder-high ball ~3° lower (CALC).
- High: prepare higher and swing more level/across, stronger grip helps, or change the height by stepping in or backing up.
  One-hander above the shoulder: slice is the practical club answer; racket speed drops at high impact (Zhang & Fujii).
- Low: bend the knees not the waist, get the racket head under the ball; closed face on a low ball = net.

## 6. Faults (see JSON for Korean cues)
Most-cited club faults: late preparation, no hip/shoulder rotation, contact beside the body, straight legs, bending at the
waist, weight staying back, stopping the swing; two-hander pulled by the bottom hand; one-hander with bent elbow and
shoulders opening early.

## 7. Models to copy
- Forehand: Nishikori, Bautista Agut, Rybakina (compact take-back on the hitting side, moderate grip), Federer's preparation.
  Avoid as models: Nadal, Alcaraz, Sinner (speed), Swiatek (true western grip), Sabalenka (flat, low margin).
- Two-hander: Djokovic (fixed wrists), Agassi (early turn, short backswing), Zverev (straight top arm). Not Medvedev (flat, low clearance).
- One-hander: Wawrinka's structure (arm straight early); Federer's late-straightening elbow and Gasquet's extreme grip are hard to time.
- 9 of 28 player entries are flagged `verified: false` (forum-level or memory only), including Pegula, Halep, Henin, Barty.

## Where sources disagree
- Contact distance in front (see §1) — choose one reference point (hitting shoulder or front hip) and calibrate on pro clips.
- Late contact → face open (most coaches, Korean sources: weight back, face up, long) vs face closed (one coach). Likely
  grip-dependent: eastern/continental open when late; semi-western/western arrive closed or jammed.
- Too far in front → face opens and ball goes high (LiveAbout, a Korean source) vs face closes and ball nets (Optimum Tennis).
- ATP backhand spin average: 1,977 vs 1,775 rpm in two ATP articles. Swiatek forehand spin: >3,200 vs ~2,600 rpm.
- Open vs square stance: pros mostly use open, yet square measured faster. Two-hander: "left hand dominant" vs "both hands equal".
- Double-bend elbow: "about 90°" vs "110–140°" in coaching texts; measured 100–130° at impact.

## Gaps worth a follow-up fetch
Landlinger Table (shoulder/hip angles at backswing and impact), Reid & Elliott 2002 full tables, Martin 2021 knee angles by
stance, Knudson & Blackwell face/path numbers, any measured club-player rpm and trunk/knee angles.
