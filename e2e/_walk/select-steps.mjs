export default async ({ page, sel, box, shot }) => {
  const L = async (i, frac = 0) => { const b = await box(i); return { x: b.x + 1 + frac * (b.width - 2), y: b.y + b.height / 2 }; };
  await sel('A-3lines', await L(5), await L(8, 0.5));
  await sel('B-end-gap-right', await L(9), { x: 790, y: 335 });
  await sel('B2-end-below-para', await L(25), { x: 700, y: 560 });
  await sel('B3-end-page-margin', await L(13), { x: 1060, y: 380 });
  await sel('B4-end-between-lines', await L(17), { x: 650, y: 441.5 + 0 });
  await sel('C-across-columns', await L(44, 0.3), await L(48, 0.5));
  await sel('C2-col1-to-col2-gap', await L(45), { x: 790, y: 250 });
  await sel('D-backward', await L(12, 0.7), await L(10, 0.2));
  await sel('E-title-to-body', await L(2), await L(6, 0.5));
};
