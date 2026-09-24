# 模型文件夹

把下载好的 MMD 模型**整个文件夹**放进这里即可，程序会自动识别。

> 也可以放在 `~/Downloads/`（旧版本的位置），程序两个地方都会找。
> 安装包版本请放到菜单「模型 → 打开模型文件夹…」指向的目录。

## 为什么仓库里没有模型文件？

这些模型是第三方为《崩坏3》角色制作的二次创作作品，每个模型压缩包里的
`使用规则.txt` 都明确写着：

```
请勿二次配布
请勿用于18禁作品，极端宗教宣传，血腥恐怖猎奇作品，人身攻击等
请勿用于商业用途
模型版权所属 miHoYo
```

**「二次配布」就是指把模型文件再分发给他人** —— 无论免费还是收费、开源还是闭源。
所以本项目的仓库和安装包都**不包含任何模型文件**，只提供读取和适配的代码，
模型请你自己从原发布页下载。这也是绝大多数 MMD 相关开源项目的通行做法。

不下载模型完全不影响使用：**内置的 Q 版猫娘是纯代码程序化生成的**，
开箱即用，没有任何版权负担。MMD 模型只是可选的进阶玩法。

## 目录结构

程序按下面的文件名查找，请保持解压出来的文件夹名不变：

```
models/
├── Kiana Kaslana - Herrscher of Flamescion/
│   └── Kiana Kaslana - Herrscher of Flamescion.pmx     薪炎律者
├── Kiana Kaslana - Herrscher of Finality/
│   └── Kiana Kaslana.pmx                               终焉律者
└── Kiana Kaslana - World Diva/
    └── Kiana Kaslana - World Diva.pmx                  崩坏的歌姬 World Diva
```

文件夹名不一样也没关系 —— 用菜单里的「模型 → 选择其他 PMX 模型…」手动指定，
任意 PMX/PMD 模型都能加载（窗口比例会用默认值，可能需要微调）。

## 模型来源与致谢

| 模型 | 编辑者 | 版权 |
| --- | --- | --- |
| 薪炎律者 Herrscher of Flamescion | 神帝宇 | miHoYo |
| 终焉律者 Herrscher of Finality | 神帝宇 | miHoYo |
| 崩坏的歌姬 World Diva | 见模型包内说明 | miHoYo |

感谢模型作者的制作。使用时请遵守各模型自带的 `使用规则.txt`。
