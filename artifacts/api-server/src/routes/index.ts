import { Router, type IRouter } from "express";
import dataRouter from "./data";
import healthRouter from "./health";
import modelRouter from "./model";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dataRouter);
router.use(modelRouter);

export default router;
