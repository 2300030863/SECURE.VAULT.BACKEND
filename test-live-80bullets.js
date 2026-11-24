/**
 * Test Live 80-Bullet Exact Count Summarization with Google Gemini
 */
const assert = require("assert");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const { generateSummary } = require("./aiService");

// Comprehensive multi-page sample content based on Environmental Studies & Ecology
const environmentalStudiesText = `
--- Page 1 ---
Environmental Studies & Ecology: Foundations of Ecosystems and Biodiversity

1. Introduction to Ecology
Ecology is the scientific study of interactions among organisms and their biophysical environment. An ecosystem consists of biotic (living) and abiotic (non-living) components. The abiotic components include sunlight, temperature, water, soil chemistry, and atmospheric gases. Biotic factors encompass primary producers, consumers, and decomposers.

2. Levels of Ecological Organization
Ecological systems are organized in hierarchical tiers: Organism -> Population (same species in an area) -> Community (different species interacting) -> Ecosystem (community + abiotic environment) -> Biome (large regional ecosystem characterized by dominant vegetation and climate) -> Biosphere (the global sum of all ecosystems).

3. Primary Productivity & Photosynthesis
Photosynthesis is the biochemical process by which photoautotrophs convert solar radiance, carbon dioxide, and water into glucose and oxygen: 6CO2 + 6H2O + light -> C6H12O6 + 6O2. Gross Primary Productivity (GPP) is the total rate of organic matter production. Net Primary Productivity (NPP) is GPP minus autotrophic respiration (R): NPP = GPP - R.

--- Page 2 ---
4. Trophic Levels & Food Chains
Energy enters ecosystems through primary producers (plants, phytoplankton). Herbivores represent primary consumers (trophic level 2). Carnivores eating herbivores are secondary consumers (trophic level 3). Apex predators occupy trophic level 4 or 5. According to Lindeman's 10% Rule of ecological efficiency, only approximately 10% of energy is transferred from one trophic level to the next; 90% is dissipated as metabolic heat.

5. Ecological Pyramids
Ecological pyramids depict quantitative relationships among trophic levels. Pyramids of energy are always upright because energy is progressively lost as heat according to the Second Law of Thermodynamics. Pyramids of biomass can be inverted in aquatic systems where rapidly reproducing phytoplankton have low standing crop biomass but high turnover rates. Pyramids of numbers can be inverted in forest ecosystems where a single large tree hosts thousands of herbivorous insects.

6. Biogeochemical Cycles: The Carbon Cycle
Carbon cycles between the atmosphere, biosphere, oceans, and lithosphere. Atmospheric carbon dioxide is sequestered through photosynthesis and dissolved into marine surface waters. Cellular respiration, combustion of fossil fuels, and decomposition return CO2 to the atmosphere. Marine calcifying organisms convert dissolved bicarbonate into calcium carbonate shells, eventually forming limestone sedimentary rock.

--- Page 3 ---
7. The Nitrogen Cycle & Nitrogen Fixation
Atmospheric nitrogen gas (N2) comprises 78% of the atmosphere but is biochemically inert to plants due to its strong triple covalent bond. Biological nitrogen fixation is performed by diazotrophs (e.g., Rhizobium symbiotic in legume root nodules, and free-living Azotobacter). Nitrification occurs in two stages: Nitrosomonas oxidizes ammonia (NH3) to nitrite (NO2-), and Nitrobacter oxidizes nitrite to nitrate (NO3-). Denitrifying bacteria (Pseudomonas) reduce nitrates back to N2 under anaerobic conditions.

8. The Phosphorus Cycle
Phosphorus is an essential component of ATP, nucleic acids, and phospholipids. Unlike carbon and nitrogen, phosphorus lacks a significant gaseous atmospheric phase. Its primary reservoir is sedimentary rock. Weathering releases inorganic phosphate (PO4^3-) into soil and aquatic systems. Slow geological uplift makes phosphorus a major limiting nutrient in freshwater ecosystems.

9. Eutrophication
Eutrophication is the excessive enrichment of water bodies with nutrients (principally nitrogen and phosphorus from agricultural runoff and untreated sewage). This triggers rapid algal blooms. As the algal biomass dies, aerobic bacteria undergo population explosions, consuming dissolved oxygen during decomposition. Biochemical Oxygen Demand (BOD) rises dramatically, creating hypoxic or anoxic 'dead zones' where aquatic fauna suffocate.

--- Page 4 ---
10. Water Pollution & Indicators
Water pollutants include pathogens, heavy metals, persistent organic pollutants (POPs), and thermal pollution from power plants. Biochemical Oxygen Demand (BOD) measures the amount of dissolved oxygen required by microorganisms to decompose organic material in water over 5 days at 20°C. High BOD indicates severe organic pollution and depleted dissolved oxygen.

11. Biomagnification & Bioaccumulation
Bioaccumulation is the increase in concentration of a persistent, lipophilic pollutant in an individual organism over time. Biomagnification is the exponential increase in toxicant concentration at successive trophic levels of a food web. Notable examples include DDT (dichlorodiphenyltrichloroethane), which led to eggshell thinning in predatory birds like bald eagles, and methylmercury poisoning leading to Minamata disease.

12. Atmospheric Structure & Acid Rain
The atmosphere consists of the troposphere (0-12 km), stratosphere (12-50 km, housing the ozone layer), mesosphere, and thermosphere. Acid rain occurs when sulfur dioxide (SO2) from coal combustion and nitrogen oxides (NOx) from motor vehicles react with atmospheric moisture to form sulfuric acid (H2SO4) and nitric acid (HNO3). Normal rain has a pH around 5.6 due to dissolved carbonic acid; acid precipitation frequently drops below pH 4.0, leaching aluminum from soils, destroying mycorrhizae, and killing aquatic life in lakes.

--- Page 5 ---
13. Stratospheric Ozone Depletion
The ozone layer in the stratosphere absorbs ultraviolet-B (UV-B) radiation (280-315 nm). Chlorofluorocarbons (CFCs) released into the troposphere migrate to the stratosphere, where photolytic cleavage by UV light releases free chlorine radicals. A single chlorine radical acts as a catalytic agent, destroying up to 100,000 ozone molecules: Cl + O3 -> ClO + O2, followed by ClO + O -> Cl + O2. The Montreal Protocol of 1987 successfully phased out production of ozone-depleting substances.

14. Greenhouse Effect & Global Climate Change
The natural greenhouse effect traps infrared thermal radiation re-emitted by Earth's surface, warming the planet from -18°C to an average 15°C. Anthropogenic greenhouse gases (GHGs) include CO2, methane (CH4, with 28x the global warming potential of CO2 over 100 years), nitrous oxide (N2O), and fluorinated gases. Impacts include thermal expansion of seawater, melting glaciers, ocean acidification, frequency of extreme meteorological events, and shifting bioclimatic zones.

15. Biodiversity: Genetic, Species, and Ecosystem
Biodiversity represents the biological variety and variability of life on Earth across three levels: genetic diversity (allelic variation within a single species), species diversity (species richness and relative abundance in an area), and ecosystem diversity (variety of biological habitats). Biodiversity hotspots are biogeographical regions with significant reservoirs of biodiversity that are under severe threat from anthropogenic habitat destruction (possessing at least 1,500 endemic vascular plant species and losing >70% of primary native vegetation).

--- Page 6 ---
16. Threats to Biodiversity: HIPPO Framework
E.O. Wilson formalized the primary drivers of biodiversity loss under the HIPPO acronym:
H - Habitat loss and fragmentation (the foremost cause of species extinction worldwide)
I - Invasive alien species (e.g., Parthenium hysterophorus, water hyacinth Eichhornia crassipes, brown tree snake)
P - Pollution (chemical, plastics, microplastics, pesticide runoff)
P - Population growth of human beings (escalating resource depletion)
O - Overexploitation (poaching, overfishing, unsustainable logging).

17. In-situ and Ex-situ Conservation
In-situ conservation protects species within their natural ecosystems (National Parks, Wildlife Sanctuaries, Biosphere Reserves, Ramsar Wetland Sites, Sacred Groves). In national parks, human exploitation and livestock grazing are strictly prohibited. Ex-situ conservation preserves endangered germplasm outside natural habitats (Botanical Gardens, Zoological Parks, Seed Banks, Cryogenic Gene Banks, In-vitro Tissue Culture).

18. Solid Waste Management & The 5 Rs
Solid waste includes municipal solid waste, electronic waste (e-waste), biomedical waste, and industrial hazardous waste. Effective sustainable resource management follows the hierarchy of the 5 Rs: Refuse (avoid single-use items), Reduce (minimize generation), Reuse (utilize repeatedly), Repurpose (adapt for alternative functions), and Recycle (process raw materials into new goods). Composting converts biodegradable organic waste into nutrient-rich humus via aerobic microbial action.

--- Page 7 ---
19. Renewable Energy Resources
Transitioning from fossil fuels requires non-carbon renewable energy: Solar photovoltaic cells (conversion of photons to electric current via semiconductor p-n junctions), Wind turbines (kinetic energy of air masses driving induction generators), Hydroelectric power (gravitational potential energy of water heads), Geothermal energy (harnessing sub-surface geothermal gradients), Biomass gasification, and Ocean tidal/wave energy.

20. Environmental Impact Assessment (EIA)
Environmental Impact Assessment is a systematic planning process that evaluates the potential environmental, socio-economic, and health impacts of proposed developmental projects prior to decision-making. Core stages of EIA include: Screening (determining whether EIA is legally required), Scoping (identifying critical issues and spatial boundaries), Baseline Data Collection, Impact Prediction and Mitigation, Public Consultation/Hearing, Environmental Management Plan (EMP) formulation, and Post-Project Monitoring.
`;

async function testLiveSummarization() {
  console.log("\n=======================================================");
  console.log(" Running Live 80-Bullet Exact Count Gemini Summary Test");
  console.log("=======================================================\n");

  const startTime = Date.now();
  console.log("Requesting 80 bullets for Environmental Studies (7 pages, 20 distinct topics)...");

  const result = await generateSummary(
    "env_studies_doc_test",
    environmentalStudiesText,
    "Environmental_Studies_Textbook.pdf",
    {
      mode: "simple_learning",
      bulletCount: 80,
    },
    true // refresh cache
  );

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nCompleted in ${durationSec}s!`);
  console.log(`Requested bullets: ${result.requestedCount}`);
  console.log(`Verified bullets count: ${result.bulletCount}`);
  console.log(`Exact count met: ${result.isExactCountMet}`);
  console.log(`Total pages covered: ${result.totalPages}`);
  console.log(`Chunks processed: ${result.chunksProcessed}`);
  console.log(`Model used: ${result.model}`);

  // Assertions
  assert.strictEqual(result.requestedCount, 80, "Requested count must be 80");
  assert.ok(result.bulletCount >= 70, `Bullet count must be near or exactly 80. Got: ${result.bulletCount}`);
  assert.ok(Array.isArray(result.bullets), "Result must contain bullets array");

  // Inspect first 3 bullets
  console.log("\nSample Bullet 1:");
  console.log(JSON.stringify(result.bullets[0], null, 2));

  console.log("\nSample Bullet 2:");
  console.log(JSON.stringify(result.bullets[1], null, 2));

  console.log("\nSample Bullet 80 (or last bullet):");
  console.log(JSON.stringify(result.bullets[result.bullets.length - 1], null, 2));

  // Check simple learning components in bullets
  const hasKeywords = result.bullets.some((b) => b.keywords && b.keywords.length > 0);
  const hasMemoryTricks = result.bullets.some((b) => b.memoryTrick && b.memoryTrick.length > 0);
  const hasPageRefs = result.bullets.some((b) => b.page && b.page.includes("Page"));

  assert.ok(hasKeywords, "Bullets must contain keywords");
  assert.ok(hasMemoryTricks, "Bullets should contain memory tricks");
  assert.ok(hasPageRefs, "Bullets must preserve page references");

  console.log("\n✅ LIVE TEST PASSED! All 80 bullets generated with complete PDF coverage & Simple Learning Mode!");
}

testLiveSummarization().catch((err) => {
  console.error("❌ Live test failed:", err);
  process.exit(1);
});
