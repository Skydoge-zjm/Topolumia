# 扩散超分辨率文献笔记

## P-SR3

Image Super-Resolution via Iterative Refinement 将超分辨率建模为条件扩散过程。复现时不能只记录最终图像；至少需要固定低分辨率退化过程、训练/验证 split、采样步数、checkpoint 和 evaluator 版本。

当前复现关注：在 SR3-style baseline 上加入 degradation-aware conditioning 后，感知指标是否稳定改善，以及这种改善是否以像素保真下降为代价。

## P-RES_SHIFT

ResShift 使用 residual shifting 提高扩散超分效率。对当前实验的启发不是直接替换模型，而是把 noise schedule 与 conditioning 分开作为因子；否则无法判断 G1 到 G2 的变化由谁产生。

## 尚未解决

- SR3 原文设置与当前 DIV2K-valid-x4 pipeline 的退化核并不完全等价；
- LPIPS backbone 与归一化方式未在旧笔记中写清；
- 需要保存逐图像 metric，而不只保留 aggregate。
