# DiffusionSR 复现实验计划

当前问题：degradation-aware conditioning 是否真正改善感知质量，还是只是产生更锐利但偏离参考图像的纹理？

## 已完成组

- G0：SR3-style baseline；conditioning=none；schedule=baseline；50 sampler steps；seed 42。
- G1：加入 degradation encoder；其余保持与 G0 一致；seed 42。
- G2：保留 degradation encoder，同时切换为 logSNR-corrected schedule；seed 42。

## 解释限制

G1 与 G0 可以估计 conditioning 在 baseline schedule 下的差异。G2 与 G1 可以估计 schedule 在 conditioning=on 下的差异，但目前没有 conditioning=off + corrected schedule 这个 cell，因此不能分离主效应与 interaction。所有组只有一个 seed。

## 下一组候选 G3

运行 conditioning on/off × schedule baseline/corrected × seeds 13/42/73。固定 dataset split、checkpoint step、sampler steps、metric implementation 和 artifact 命名。输出 aggregate 与逐图像 PSNR、SSIM、LPIPS、FID 输入特征。
