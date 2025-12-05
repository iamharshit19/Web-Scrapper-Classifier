# Image Classifier + Web Scraper (Short README)

This repo contains **two separate tools**:

## 1. Python Image Classifier (BLIP + CLIP)

Runs through folders of images, generates captions using **BLIP**, classifies them into **Interior / Exterior / Others**, then assigns fine labels using **CLIP**.

### Features

* BLIP caption → coarse classification
* CLIP similarity → fine labels
* Letterbox resizing, EXIF correction
* Saves results into structured folders
* Creates a `classification_log.json`

### Requirements

```bash
pip install torch transformers pillow tqdm
pip install git+https://github.com/openai/CLIP.git
```

### Usage

* Put images inside: `MAIN_FOLDER/<model_name>/`
* Run the script:

```bash
python Classifier.py
```

* Output is saved in:

```
OUTPUT_BASE/<model>/{Exterior,Interior,Others}/
classification_log.json
```

---

## 2. Node.js Website Image Scraper (Playwright)

Scrapes high-resolution images from websites using scrolling + DOM parsing + network capture.

### Features

* Auto-scrolling for lazy images
* Extracts URLs from `<img>`, CSS backgrounds, JSON-LD, and network responses
* Concurrent download system
* Per-site `summary.json` + global `overall-summary.json`

### Requirements

```bash
npm install playwright csv-parse p-limit
npx playwright install
```

### Usage

CSV format:

```
url,folder_name
https://www.example.com,example
```

Run:

```bash
node Scrapper.js sites.csv downloads/
```

Output stored in:

```
downloads/<folder_name>/
  - downloaded images
  - summary.json
overall-summary.json
```

---

## Recommended Workflow

1. Use scraper → collect images.
2. Feed downloaded folders into classifier.
3. Get labeled, structured datasets automatically.

