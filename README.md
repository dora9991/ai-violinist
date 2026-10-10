# AIバイオリニスト

曲を入れると、AI がバイオリンのパートを書き足します。

- **歌っているところ**は、裏でそっと（長い音・分散和音・刻み）
- **サビ**は、歌に寄りそう対旋律
- **間奏・イントロ**は、プロのアレンジ（877 曲）とギターソロから学んだ「次のコードへのつながり方」で 1 音ずつ選ぶソロ
- **歌の息つぎ**には、次に歌い出す音へつながる合いの手
- **目立つリフ**は、バイオリンでまねる
- **保存**：ミックス（WAV）・バイオリンだけ（WAV）・MIDI（テンポと小節線入り）・楽譜（印刷・PDF）・MusicXML

## 使い方
ページを開いて、曲（mp3 / m4a / wav など）をドロップするだけ。インストールはいりません。
**曲はパソコンの中だけで処理します。どこにも送りません。**

パソコンの Chrome・Safari・Edge で動きます。

## 使っている素材とライセンス
| 部分 | 素材 | ライセンス |
|---|---|---|
| バイオリンの音 | [VSCO 2 Community Edition](https://versilian-studios.com/vsco-community/) Solo Violin（Versilian Studios） | CC0 |
| 旋律のつながり方 | [POP909](https://github.com/music-x-lab/POP909-Dataset)（Wang ほか, ISMIR 2020）の副旋律・歌のメロディから学んだ統計 | MIT |
| 旋律のつながり方・ソロのフレーズ | [GuitarSet](https://doi.org/10.5281/zenodo.3371780)（Xi, Bittner, Pauwels, Ye, Bello, ISMIR 2018）のソロから学んだ統計と型 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| 歌の判定 | Google の [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)（[ONNX 版](https://huggingface.co/audiomagic/yamnet-onnx)） | Apache 2.0 |
| AI を動かす部品 | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.29.0 | MIT |
| プログラム | このリポジトリ | MIT |

## わかっている限界
- 3連符・6/8 拍子は楽譜にしません（4/4 と 3/4）
- 拍・テンポ・調・歌の場所を読みちがえることがあります。画面のボタンで直せます
- バイオリンの音は録音をつないで作っているので、本物の演奏ほど自然ではありません
