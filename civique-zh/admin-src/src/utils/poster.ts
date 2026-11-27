export type PosterKind = 'poster' | 'guide' | 'qr';

interface PosterGlobal {
  poster: (opts: { link: string; total: number }) => Promise<HTMLCanvasElement>;
  guide: (opts: { link: string }) => Promise<HTMLCanvasElement>;
  qrOnly: (link: string, size: number) => HTMLCanvasElement;
}

declare global {
  interface Window {
    Poster?: PosterGlobal;
  }
}

let loadingPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensurePosterScript(): Promise<PosterGlobal | null> {
  if (window.Poster) return window.Poster;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      await loadScript('/vendor/qrcode.js');
      await loadScript('/poster.js');
    })().catch(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
  return window.Poster || null;
}

function drawDemoPlaceholderCanvas(kind: PosterKind, link: string, total: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const isQr = kind === 'qr';
  canvas.width = isQr ? 512 : 1080;
  canvas.height = isQr ? 512 : 1440;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  if (isQr) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#00A66C';
    ctx.lineWidth = 10;
    ctx.strokeRect(24, 24, 464, 464);

    // Draw deterministic grid pattern as QR placeholder
    ctx.fillStyle = '#101815';
    const cell = 16;
    const start = 80;
    for (let r = 0; r < 22; r++) {
      for (let c = 0; c < 22; c++) {
        const isCorner =
          (r < 6 && c < 6) || (r < 6 && c >= 16) || (r >= 16 && c < 6);
        const hash = ((r * 31 + c * 17 + link.length * 7) % 5) < 2;
        if (isCorner || hash) {
          if (
            (r >= 1 && r <= 4 && c >= 1 && c <= 4 && !(r >= 2 && r <= 3 && c >= 2 && c <= 3)) ||
            (r >= 1 && r <= 4 && c >= 17 && c <= 20 && !(r >= 2 && r <= 3 && c >= 18 && c <= 19)) ||
            (r >= 17 && r <= 20 && c >= 1 && c <= 4 && !(r >= 18 && r <= 19 && c >= 2 && c <= 3))
          ) {
            continue;
          }
          ctx.fillRect(start + c * cell, start + r * cell, cell - 2, cell - 2);
        }
      }
    }

    ctx.fillStyle = '#5C6B64';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('演示模式二维码占位图', 256, 462);
    return canvas;
  }

  // 1080 x 1440 Poster or Guide placeholder
  const grad = ctx.createLinearGradient(0, 0, 0, 1440);
  grad.addColorStop(0, '#00704A');
  grad.addColorStop(0.42, '#00A66C');
  grad.addColorStop(1, '#F4F8F6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1440);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('kaocivique', 540, 170);

  ctx.fillStyle = '#FFC933';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText(kind === 'poster' ? `法国公民考试中文题库（共 ${total || 617} 题）` : '添加到手机桌面使用教程', 540, 260);

  // White card
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(100, 360, 880, 920, 40);
  ctx.fill();

  ctx.fillStyle = '#101815';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(kind === 'poster' ? '扫码立即开始练习' : 'Safari / 微信扫码打开', 540, 470);

  // QR placeholder box inside card
  const qrCanvas = drawDemoPlaceholderCanvas('qr', link, total);
  ctx.drawImage(qrCanvas, 284, 540, 512, 512);

  ctx.fillStyle = '#00704A';
  ctx.font = '28px monospace';
  ctx.fillText(link, 540, 1130);

  ctx.fillStyle = '#5C6B64';
  ctx.font = '26px sans-serif';
  ctx.fillText('演示模式占位图 · 正式环境自动调用 /poster.js', 540, 1210);

  return canvas;
}

export async function generatePosterCanvas(
  kind: PosterKind,
  opts: { link: string; total: number },
  demoMode: boolean,
): Promise<{ canvas: HTMLCanvasElement; isFallback: boolean }> {
  if (!demoMode) {
    const posterLib = await ensurePosterScript();
    if (posterLib) {
      if (kind === 'poster') {
        return { canvas: await posterLib.poster({ link: opts.link, total: opts.total }), isFallback: false };
      }
      if (kind === 'guide') {
        return { canvas: await posterLib.guide({ link: opts.link }), isFallback: false };
      }
      return { canvas: posterLib.qrOnly(opts.link, 512), isFallback: false };
    }
  }

  return { canvas: drawDemoPlaceholderCanvas(kind, opts.link, opts.total), isFallback: true };
}

export function getPosterFilename(code: string, kind: PosterKind): string {
  const tag = code || 'home';
  if (kind === 'poster') return `kaocivique-${tag}-poster.png`;
  if (kind === 'guide') return `kaocivique-${tag}-desktop-guide.png`;
  return `kaocivique-${tag}-qr.png`;
}

export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
