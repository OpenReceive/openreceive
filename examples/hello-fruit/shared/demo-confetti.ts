/**
 * Dependency-free confetti burst for the demo's payment-settled moment. Each call
 * paints its own full-screen canvas overlay (pointer-events: none, above the sticker
 * modal) and removes it when the animation ends.
 */

const CONFETTI_COLORS = ["#f43f5e", "#f59e0b", "#facc15", "#22c55e", "#3b82f6", "#a855f7"];
const CONFETTI_PARTICLES = 160;
const CONFETTI_DURATION_MS = 2800;

interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  rotationSpeed: number;
}

export function launchHelloFruitConfetti(): void {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return;
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.append(canvas);

  const particles: ConfettiParticle[] = Array.from({ length: CONFETTI_PARTICLES }, () => ({
    // Launch upward from the bottom half so pieces arc over the checkout/modal.
    x: canvas.width * (0.2 + Math.random() * 0.6),
    y: canvas.height * (0.6 + Math.random() * 0.4),
    vx: (Math.random() - 0.5) * 14,
    vy: -(8 + Math.random() * 14),
    size: 5 + Math.random() * 6,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)] as string,
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 0.4,
  }));

  const startedAt = performance.now();
  function frame(now: number): void {
    const elapsed = now - startedAt;
    if (elapsed >= CONFETTI_DURATION_MS) {
      canvas.remove();
      return;
    }
    if (context === null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = Math.min(1, (CONFETTI_DURATION_MS - elapsed) / 600);
    for (const particle of particles) {
      particle.vy += 0.35;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rotation += particle.rotationSpeed;
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.rotation);
      context.fillStyle = particle.color;
      context.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.6);
      context.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
