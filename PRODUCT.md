# Product

## Register

product

## Users

Edge Impulse users (ML engineers, embedded / hardware developers, applied researchers) who need labeled training data they cannot practically collect in the physical world. They open the studio mid-experiment, on a laptop, while a model is being iterated. Sessions are short and goal-bound: capture a batch, push it to an Edge Impulse project, return to training. The tool is one stop in a longer pipeline, not a destination.

## Product Purpose

Generate synthetic 3D training data (accelerometer signals, object-detection frames, visual-anomaly samples, and robotics telemetry) in the browser and ingest it directly into an Edge Impulse project. Success means a user can go from "I need more samples of class X under condition Y" to a labeled batch landed in their EI project without leaving the page or stitching scripts together.

## Brand Personality

Inherits Edge Impulse: precise, technical, approachable. Confident without being loud. The interface should read like an instrument that respects the user's expertise, not a tutorial that hand-holds them.

Three words: precise, calm, instrument-grade.

## Anti-references

- Neon-on-black "AI" theatrics (glow effects, cyberpunk gradients, particle backgrounds).
- Generic SaaS-cream dashboards (rounded white cards on off-white, pastel pill badges, hero-metric tiles).
- Glassmorphism floating panels (blurred translucent surfaces used decoratively).
- Cyberpunk gradient borders or animated outline tricks.
- Anything that decorates the chrome at the expense of the 3D scene.

## Design Principles

1. **The scene is the document.** The 3D viewport is what the user is reasoning about. Chrome surrounds it; chrome never competes with it.
2. **Calm under workload.** Density is fine; noise is not. Color, motion, and weight are spent on state changes that matter (recording, errors, completion), not on decoration.
3. **One accent, with meaning.** The teal accent signals "live / on / connected." It is not a decorative flourish. If everything is accented, nothing is.
4. **Instrumentation, not decoration.** Numbers, states, and counts are precise and trustworthy. Monospace where precision matters; proportional where reading matters. No fake polish.
5. **Respect the pipeline.** This tool is a stop on the way to Edge Impulse. Surfaces that connect to EI (auth, project, ingestion status) are first-class and unambiguous.

## Accessibility & Inclusion

- WCAG 2.1 AA contrast for all text and interactive controls.
- Full keyboard reachability for every control (sidebar, capture, EI auth, mode switching).
- `prefers-reduced-motion` respected: the recording pulse, drawer slide, and any decorative motion downgrade to a static state.
- Status is never conveyed by color alone (icon / text / state label always accompanies green-vs-red).
