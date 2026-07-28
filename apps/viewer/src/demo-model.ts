import demoCity from "../../../examples/demo-city.json" with { type: "json" };

import { validateCityModel } from "./model-validation.js";

export const DEMO_MODEL = validateCityModel(demoCity);
