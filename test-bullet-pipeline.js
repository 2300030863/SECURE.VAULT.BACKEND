/**
 * Test script for Exact Bullet Count & Complete PDF Summarization Logic
 */
const assert = require("assert");

// 1. Test Bullet Parser
function parseBulletPoints(text, defaultPage = "Page 1") {
  const bullets = [];
  if (!text || typeof text !== "string") return bullets;

  // Split by numbered items: e.g. "1. ", "2. ", "\n3. " or "\n\n1. "
  const rawItems = text.split(/\n(?=\s*\d+[\.\)]\s+)/);

  for (const item of rawItems) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Check if it starts with a number
    const matchNumber = trimmed.match(/^(\d+)[\.\)]\s+([\s\S]+)$/);
    if (!matchNumber) continue;

    const itemContent = matchNumber[2].trim();

    // Extract topic and page reference
    let topic = "";
    let pageRef = defaultPage;

    const pageMatch = itemContent.match(/\[(?:Page|Section|Slide)\s*([0-9\-]+)\]/i);
    if (pageMatch) {
      pageRef = `Page ${pageMatch[1]}`;
    }

    const firstLine = itemContent.split("\n")[0].trim();
    const topicMatch = firstLine.match(/\*\*([^*]+)\*\*/);
    if (topicMatch) {
      topic = topicMatch[1].replace(/\[(?:Page|Section|Slide)[^\]]+\]/gi, "").trim();
    } else {
      topic = firstLine
        .replace(/\[(?:Page|Section|Slide)[^\]]+\]/gi, "")
        .replace(/^[-*#\s]+/, "")
        .replace(/:\s*$/, "")
        .slice(0, 60)
        .trim();
    }

    // Extract Simple Explanation
    let explanation = "";
    const explMatch = itemContent.match(/(?:Simple Explanation|Explanation|Concept|Meaning):\s*([\s\S]*?)(?=\n\s*[-*•]\s*(?:Important Keywords|Keywords|Key Terms|Memory Trick|Example)|$)/i);
    if (explMatch) {
      explanation = explMatch[1].replace(/\n+/g, " ").trim();
    } else {
      const lines = itemContent.split("\n").slice(1).map((l) => l.replace(/^[-*•\s]+/, "").trim()).filter(Boolean);
      explanation = lines[0] || itemContent.replace(/\*\*[^*]+\*\*/, "").trim();
    }

    // Extract Keywords
    let keywords = [];
    const kwMatch = itemContent.match(/(?:Important Keywords|Keywords|Key Terms):\s*([^\n]+)/i);
    if (kwMatch) {
      keywords = kwMatch[1].split(/[,;•|]/).map((k) => k.replace(/[*_]/g, "").trim()).filter(Boolean);
    }

    // Extract Example / Memory Trick
    let memoryTrick = "";
    const memMatch = itemContent.match(/(?:Example \/ Memory Trick|Memory Trick|Example|Analogy):\s*([\s\S]*?)(?=\n\s*\d+[\.\)]|$)/i);
    if (memMatch) {
      memoryTrick = memMatch[1].replace(/\n+/g, " ").trim();
    }

    bullets.push({
      topic: topic || `Concept ${bullets.length + 1}`,
      page: pageRef,
      explanation: explanation || "Essential concept explained simply for students.",
      keywords: keywords.length > 0 ? keywords : [topic],
      memoryTrick: memoryTrick || null,
      rawText: trimmed,
    });
  }

  return bullets;
}

// 2. Test Deduplication
function deduplicateBullets(bullets) {
  const seen = new Set();
  const unique = [];

  for (const b of bullets) {
    const norm = (b.topic || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!norm) {
      unique.push(b);
      continue;
    }
    if (!seen.has(norm)) {
      seen.add(norm);
      unique.push(b);
    }
  }

  return unique;
}

// 3. Test Proportional Sampling for Exact Count
function sampleExactCount(bullets, targetCount) {
  if (bullets.length <= targetCount) return bullets;
  const sampled = [];
  const total = bullets.length;
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.floor((i * total) / targetCount);
    sampled.push(bullets[idx]);
  }
  return sampled;
}

// Run Unit Tests
console.log("Running Bullet Pipeline Tests...");

const sampleText = `
1. **Eutrophication [Page 3]**
   - **Simple Explanation:** Too many nutrients enter water, causing algae to grow very quickly. When algae die, bacteria break them down and use up dissolved oxygen, suffocating fish.
   - **Important Keywords:** Nutrients, Algal bloom, Oxygen depletion, Decomposition.
   - **Example / Memory Trick:** 💡 Extra nutrients → More algae → Less oxygen → Fish die.

2. **Acid Rain [Page 5]**
   - **Simple Explanation:** Factory emissions of sulfur dioxide mix with rain clouds and create acidic precipitation that damages trees and lakes.
   - **Important Keywords:** Sulfur dioxide, Nitrogen oxide, Acid precipitation.
   - **Example / Memory Trick:** Factory smoke + Cloud water = Sour rain that kills trees.

3. **Eutrophication [Page 7]**
   - **Simple Explanation:** Repetition of algae blooming in lakes.
   - **Important Keywords:** Algae.

4. **Biomagnification [Page 8]**
   - **Simple Explanation:** Toxic chemicals become more concentrated at each step up the food chain, harming top predators the most.
   - **Important Keywords:** Heavy metals, Food chain, Trophic levels, DDT.
   - **Example / Memory Trick:** Small fish eats plastic → Big fish eats 10 small fish → Eagle eats 5 big fish (highest poison).
`;

const parsed = parseBulletPoints(sampleText);
console.log("Parsed count:", parsed.length);
assert.strictEqual(parsed.length, 4, "Should parse 4 bullets");
assert.strictEqual(parsed[0].topic, "Eutrophication");
assert.strictEqual(parsed[0].page, "Page 3");
assert.ok(parsed[0].explanation.includes("Too many nutrients"));
assert.strictEqual(parsed[0].keywords.length, 4);
assert.ok(parsed[0].memoryTrick.includes("Extra nutrients"));

const deduped = deduplicateBullets(parsed);
console.log("Deduped count:", deduped.length);
assert.strictEqual(deduped.length, 3, "Duplicate Eutrophication should be removed");

// Test sampling down to 2
const sampled = sampleExactCount(deduped, 2);
assert.strictEqual(sampled.length, 2, "Should sample down to exactly 2");

console.log("✅ All Bullet Pipeline unit tests passed successfully!");
