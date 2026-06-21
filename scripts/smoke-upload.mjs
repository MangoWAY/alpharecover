import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const filePath = path.join(root, "test-assets", "sample-split.svg");
const targetUrl = process.env.SMOKE_URL ?? "http://localhost:3000";

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1020 });
  await page.goto(targetUrl, { waitUntil: "networkidle0" });
  const input = await page.$('input[type="file"]');
  if (!input) throw new Error("File input not found");
  await input.uploadFile(filePath);
  await page.waitForFunction(
    () => {
      const downloadButton = Array.from(document.querySelectorAll("button")).find((button) =>
        /Download (PNG|ZIP)/.test(button.textContent ?? "")
      );
      return Boolean(downloadButton && !downloadButton.disabled && document.body.innerText.includes("Ready"));
    },
    { timeout: 10000 }
  );
  const result = await page.evaluate(() => ({
    text: document.body.innerText,
    images: Array.from(document.images).map((img) => ({
      src: img.getAttribute("src"),
      width: img.naturalWidth,
      height: img.naturalHeight
    }))
  }));
  if (!result.text.includes("Ready")) throw new Error("Recovered item did not become ready");
  if (!result.images.some((image) => image.src?.startsWith("blob:") && image.width > 0 && image.height > 0)) {
    throw new Error("Recovered blob image was not rendered");
  }
  console.log("smoke-upload ok");
} finally {
  await browser.close();
}
