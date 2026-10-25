// Renders scripts/icon.svg to the PNG sizes Chrome wants.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const svg = readFileSync("scripts/icon.svg", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: `public/icons/${size}.png`, omitBackground: true });
}
await browser.close();
console.log("icons written");
