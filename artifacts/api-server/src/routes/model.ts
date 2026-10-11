import { Router, type IRouter } from "express";
import { GetModelPerformanceResponse } from "@workspace/api-zod";
import { getModelPerformance } from "../services/prediction-log";

const router: IRouter = Router();

/**
 * Rendimiento real del modelo sobre las apuestas ya liquidadas: ROI (con error estándar),
 * CLV aproximado y Brier del modelo vs. mercado. Es la única forma honesta de saber si
 * el modelo tiene ventaja. Contrato en lib/api-spec/openapi.yaml (ModelPerformance).
 */
router.get("/model/performance", async (_req, res): Promise<void> => {
  res.json(GetModelPerformanceResponse.parse(await getModelPerformance()));
});

export default router;
