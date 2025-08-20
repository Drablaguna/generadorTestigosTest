const stream = require("stream");
const puppeteer = require("puppeteer");
const { google } = require("googleapis");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
// TODO Schedule to run 18:00 M-F, 12:00 SAT, 9:00 SUN

// ---------------------------------- UTILS ----------------------------------
async function generateYMDDate() {
  const currentDate = new Date();
  return currentDate.toISOString().split("T")[0].replace(/-/g, "_");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------- PUPPETEER  --------------------------------
async function createBrowserAndCaptureScreenshot(website) {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });
  await page.setDefaultNavigationTimeout(60000);

  try {
    await page.goto(website, {
      waitUntil: "networkidle0",
    });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      fullPage: false,
      encoding: "binary",
    });

    const screenshotStream = new stream.PassThrough();
    screenshotStream.end(screenshotBuffer);

    return screenshotStream;
  } catch (err) {
    throw new Error(
      err instanceof puppeteer.errors.TimeoutError
        ? `Timeout exceeded while capturing screenshot`
        : `Screenshot capture failed: ${err.message}`
    );
  } finally {
    await browser.close();
  }
}

async function captureScreenshotWithRetries(
  maxRetries = 5,
  baseDelayMs = 1000,
  maxWaitMs = 10000
) {
  let attempt = 0;
  const startTime = Date.now();

  while (attempt < maxRetries) {
    attempt++;
    try {
      console.log(`Attempt ${attempt} to capture screenshot...`);
      const stream = await createBrowserAndCaptureScreenshot(
        "https://www.mcvnoticias.com/"
      );
      const totalTime = Date.now() - startTime;
      console.log(
        `✅ Screenshot captured successfully on attempt ${attempt} after ${totalTime} ms`
      );
      return stream;
    } catch (err) {
      console.error(`❌ Attempt ${attempt} failed: ${err.message}`);

      if (attempt >= maxRetries) {
        const totalTime = Date.now() - startTime;
        throw new Error(
          `Failed after ${maxRetries} attempts (${totalTime} ms total)`
        );
      }

      let waitTime = baseDelayMs * Math.pow(2, attempt - 1);
      waitTime = Math.min(waitTime, maxWaitMs);
      console.log(`⏳ Waiting ${waitTime}ms before retrying...`);
      await delay(waitTime);
    }
  }
}

// ---------------------------------- DRIVE ----------------------------------
async function authorize() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID or CLIENT_SECRET");
  }
  if (!REFRESH_TOKEN) {
    throw new Error("Missing refresh_token");
  }

  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

  try {
    await oAuth2Client.getAccessToken();
    console.log("Google Drive auth successful");
  } catch (err) {
    console.error("Google Drive auth failed:", err.message);
    throw new Error(
      "Auth validation failed — check your credentials and refresh token."
    );
  }

  return oAuth2Client;
}

async function assertFileInDriveFolderExists(filename, filesInDriveArray) {
  return filesInDriveArray.some((file) => file.name === filename);
}

async function getDriveFolderFiles(authClient, folderId) {
  if (!authClient) {
    throw new Error("No auth client passed to getDriveFolderFiles");
  }
  const drive = google.drive({ version: "v3", auth: authClient });
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(name)",
    });

    if (!res.data.files) {
      console.warn("No files found or API returned empty list.");
      return [];
    }

    return res.data.files;
  } catch (err) {
    console.error("Error listing files:", err);
    throw new Error(`Error: ${err}`);
  }
}

async function storeFileInDrive(
  fileReadableStream,
  driveFolderID,
  authClient,
  filename,
  mimeType
) {
  const drive = google.drive({ version: "v3", auth: authClient });

  const fileMetadata = {
    name: filename,
    mimeType: mimeType,
    parents: [driveFolderID],
  };

  const media = {
    mimeType: mimeType,
    body: fileReadableStream,
  };

  try {
    const fileUpload = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id, parents",
    });

    const fileID = fileUpload.data.id;
    console.log(`✅ File successfully uploaded!`);
    return { isUploaded: true, fileID: fileID, error: null };
  } catch (err) {
    console.error(`❌ Upload failed: ${err.message}`);
    return { isUploaded: false, fileID: null, error: err.message };
  }
}

// ---------------------------------- MAIN ----------------------------------
(async () => {
  console.log("Ejecutando capturador testigos...");
  const currentYMDDate = await generateYMDDate();
  const auth = await authorize();

  let filesInDriveFolder = await getDriveFolderFiles(auth, DRIVE_FOLDER_ID);
  let currentDayScreenshotExists = await assertFileInDriveFolderExists(
    `${currentYMDDate}.png`,
    filesInDriveFolder
  );

  if (!currentDayScreenshotExists) {
    console.log(
      `No se encuentra testigo para ${currentYMDDate}, generando captura...`
    );
    const screenshot = await captureScreenshotWithRetries();
    const fileUploadStatus = await storeFileInDrive(
      screenshot,
      DRIVE_FOLDER_ID,
      auth,
      `${currentYMDDate}.png`,
      "image/png"
    );
    currentDayScreenshotExists = fileUploadStatus.isUploaded;
  } else {
    console.log(
      `Testigo para ${currentYMDDate} ya se encuentra en Google Drive.`
    );
  }
})();
