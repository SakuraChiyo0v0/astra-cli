# 在官方镜像上加飞书 SDK。
#
# 官方镜像把 /opt/hermes 设为 root 所有、运行期只读，并设了 HERMES_DISABLE_LAZY_INSTALLS，
# 所以飞书适配器要的 lark_oapi 不能在运行时装（装了重建容器也会丢）。版本取自 hermes
# 自己 pyproject.toml 的 feishu extra：lark-oapi==1.6.8。
#
# venv 里没有 pip，用镜像自带的 uv 装，`--no-deps` 不惊动已锁定的整套依赖。
FROM nousresearch/hermes-agent:latest

RUN UV=$(ls -d /opt/hermes/tools/uv-*/uv | head -1) && \
    "$UV" pip install --python /opt/hermes/.venv/bin/python --no-cache \
      "lark-oapi==1.6.8" "qrcode==7.4.2" && \
    /opt/hermes/.venv/bin/python -c "import lark_oapi, qrcode; print('feishu deps ok')"
