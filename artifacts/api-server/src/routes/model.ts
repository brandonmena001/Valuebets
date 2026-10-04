import { Router, type IRouter } from "express";
import { getModelPerformance } from "../services/prediction-log";

const router: IRouter = Router();

/**
 * Rendimiento real del modelo sobre las apuestas ya liquidadas: ROI (con error estándar),
 * CLV aproximado y Brier del modelo vs. mercado. Es la única forma honesta de saber si
 * el modelo tiene ventaja; no está en el OpenAPI todavía porque no lo consume el dashboard.
 */
router.get("/model/performance", async (_req, res): Promise<void> => {
  res.json(await getModelPerformance());
});

export default router;
