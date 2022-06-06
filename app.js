const puppeteer = require('puppeteer');
const S3 = require("aws-sdk/clients/s3");
const crypto = require("crypto");
const s3 = new S3({
    apiVersion: "2006-03-01",
    region: process.env.REGION
});

const sha1 = text => crypto.createHash("sha1")
    .update(text, "utf-8")
    .digest("hex");

const httpBasicAuth = JSON.parse(process.env.ENV_TO_USER_PASS);

const basicHttpAuthorization = page => {
    if (!httpBasicAuth[process.env.ENV]) {
        return Promise.resolve();
    }
    return page.authenticate({"username": httpBasicAuth[process.env.ENV]["username"], "password": httpBasicAuth[process.env.ENV]["password"]});
}

const subdomains = JSON.parse(process.env.ENV_TO_SUBDOMAINS);

const toURL = uri => "https://" + (subdomains[process.env.ENV] ?? process.env.ENV)  + "." +  process.env.DOMAIN_APEX + uri;

const dontFetchAssets = page =>
    page.setRequestInterception(true)
        .then(() => {
            page.on("request", request => {
                if (["image", "font"].indexOf(request.resourceType()) !== -1) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
        });

const wait = () => new Promise(resolve => {
    setTimeout(resolve, 2000);
});

const prerender = uri =>
    puppeteer.launch({
        // executablePath: 'google-chrome-stable',
        args: [
            '--aggressive-cache-discard',
            '--disable-cache',
            '--disable-application-cache',
            '--disable-offline-load-stale-cache',
            '--disable-gpu-shader-disk-cache',
            '--media-cache-size=0',
            '--disk-cache-size=0',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--mute-audio',
            '--no-default-browser-check',
            '--autoplay-policy=user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-notifications',
            '--disable-background-networking',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-sync',
            // '--allow-running-insecure-content',
            // '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
            // '--disable-print-preview',
            '--disable-setuid-sandbox',
            // '--disable-site-isolation-trials',
            // '--disable-speech-api',
            // '--disable-web-security',
            // '--disk-cache-size=33554432',
            // '--enable-features=SharedArrayBuffer',
            // '--hide-scrollbars',
            // '--ignore-gpu-blocklist',
            // '--in-process-gpu',
            // '--no-pings',
            '--no-sandbox',
            '--no-zygote',
            // '--use-gl=swiftshader',
            // '--window-size=1920,1080',
            '--single-process',
            '--disable-dev-shm-usage'
        ],
        defaultViewport: {
            deviceScaleFactor: 1,
            hasTouch: false,
            height: 1080,
            isLandscape: true,
            isMobile: false,
            width: 1920,
        },
        headless: true,
        ignoreHTTPSErrors: true
    }).then(browser =>
        browser.newPage()
            .then(page => {
                const url = toURL(uri);
                console.debug("Gonna prerender %s", url);
                return page.setUserAgent(process.env.USER_AGENT ?? "Prerender User Agent")
                    .then(() => page.setBypassCSP(true))
                    .then(() => basicHttpAuthorization(page))
                    .then(() => dontFetchAssets(page))
                    .then(() => page.goto(url, {timeout: 10000, waitUntil: "networkidle0"}))
                    .then(() => wait())
                    .then(() => page.content());
            })
            .finally(() => browser.close()));

const save = (content, uri) =>
    s3.putObject({
        Body: content,
        Bucket: process.env.BUCKET_NAME,
        StorageClass: "STANDARD",
        ContentType: "text/html",
        Key: sha1(uri) + "/index.html"
    }).promise().then(result => {
        console.info("Saving the pre-rendered uri %s returned %j", uri, result);
    });

const processRecord = record => {
    if (record.eventSourceARN.includes("prerenderdlqueue")) {
        console.warn("Received a message through the Dead-Letter queue:\n%j", record);
        return Promise.resolve();
    }

    let message;
    try {
        message = JSON.parse(record.body);
    } catch (e) {
        console.warn("Omitting a message, couldn't parse");
        console.warn(e, e.stack);
        return Promise.resolve();
    }

    if (!message.uri) {
        console.warn("Unexpected message received: ", JSON.stringify(message));
        return Promise.resolve();
    }

    return prerender(message.uri)
        .then(content => save(content, message.uri));
};

exports.lambdaHandler = (event) => {
    console.debug("Received:\n%j", event);

    if (!event.Records || !Array.isArray(event.Records)) {
        console.warn("Something's wrong, unexpected event");
        return Promise.resolve();
    }

    return event.Records.reduce((promise, record) => promise.then(() => processRecord(record)), Promise.resolve());
};
