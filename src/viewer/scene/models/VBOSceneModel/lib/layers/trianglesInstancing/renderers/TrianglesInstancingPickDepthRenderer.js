import {Program} from "../../../../../../webgl/Program.js";
import {createRTCViewMat, getPlaneRTCPos} from "../../../../../../math/rtcCoords.js";
import {math} from "../../../../../../math/math.js";

const tempVec3a = math.vec3();

/**
 * @private
 */
class TrianglesInstancingPickDepthRenderer {

    constructor(scene) {
        this._scene = scene;
        this._hash = this._getHash();
        this._allocate();
    }

    getValid() {
        return this._hash === this._getHash();
    }

    _getHash() {
        return this._scene._sectionPlanesState.getHash();
    }

    drawLayer(frameCtx, instancingLayer, renderPass) {

        const model = instancingLayer.model;
        const scene = model.scene;
        const gl = scene.canvas.gl;
        const state = instancingLayer._state;
        const geometry = state.geometry;
        const origin = instancingLayer._state.origin;

        if (!this._program) {
            this._allocate(instancingLayer);
            if (this.errors) {
                return;
            }
        }

        if (frameCtx.lastProgramId !== this._program.id) {
            frameCtx.lastProgramId = this._program.id;
            this._bindProgram();
        }

        const camera = scene.camera;

        gl.uniform1i(this._uRenderPass, renderPass);

        gl.uniform1i(this._uPickInvisible, frameCtx.pickInvisible);

        const pickViewMatrix = frameCtx.pickViewMatrix || camera.viewMatrix;
        const rtcPickViewMatrix = (origin) ? createRTCViewMat(pickViewMatrix, origin) : pickViewMatrix;

        gl.uniformMatrix4fv(this._uViewMatrix, false, rtcPickViewMatrix);
        gl.uniformMatrix4fv(this._uWorldMatrix, false, model.worldMatrix);

        gl.uniformMatrix4fv(this._uProjMatrix, false, frameCtx.pickProjMatrix);

        gl.uniform1f(this._uPickZNear, frameCtx.pickZNear);
        gl.uniform1f(this._uPickZFar, frameCtx.pickZFar);

        if (scene.logarithmicDepthBufferEnabled) {
            const logDepthBufFC = 2.0 / (Math.log(frameCtx.pickZFar + 1.0) / Math.LN2); // TODO: Far from pick project matrix
            gl.uniform1f(this._uLogDepthBufFC, logDepthBufFC);
        }

        const numSectionPlanes = scene._sectionPlanesState.sectionPlanes.length;
        if (numSectionPlanes > 0) {
            const sectionPlanes = scene._sectionPlanesState.sectionPlanes;
            const baseIndex = instancingLayer.layerIndex * numSectionPlanes;
            const renderFlags = model.renderFlags;
            for (let sectionPlaneIndex = 0; sectionPlaneIndex < numSectionPlanes; sectionPlaneIndex++) {
                const sectionPlaneUniforms = this._uSectionPlanes[sectionPlaneIndex];
                if (sectionPlaneUniforms) {
                    const active = renderFlags.sectionPlanesActivePerLayer[baseIndex + sectionPlaneIndex];
                    gl.uniform1i(sectionPlaneUniforms.active, active ? 1 : 0);
                    if (active) {
                        const sectionPlane = sectionPlanes[sectionPlaneIndex];
                        if (origin) {
                            const rtcSectionPlanePos = getPlaneRTCPos(sectionPlane.dist, sectionPlane.dir, origin, tempVec3a);
                            gl.uniform3fv(sectionPlaneUniforms.pos, rtcSectionPlanePos);
                        } else {
                            gl.uniform3fv(sectionPlaneUniforms.pos, sectionPlane.pos);
                        }
                        gl.uniform3fv(sectionPlaneUniforms.dir, sectionPlane.dir);
                    }
                }
            }
        }

        gl.uniformMatrix4fv(this._uPositionsDecodeMatrix, false, geometry.positionsDecodeMatrix);

        this._aModelMatrixCol0.bindArrayBuffer(state.modelMatrixCol0Buf);
        this._aModelMatrixCol1.bindArrayBuffer(state.modelMatrixCol1Buf);
        this._aModelMatrixCol2.bindArrayBuffer(state.modelMatrixCol2Buf);

        gl.vertexAttribDivisor(this._aModelMatrixCol0.location, 1);
        gl.vertexAttribDivisor(this._aModelMatrixCol1.location, 1);
        gl.vertexAttribDivisor(this._aModelMatrixCol2.location, 1);

        this._aPosition.bindArrayBuffer(geometry.positionsBuf);

        this._aFlags.bindArrayBuffer(state.flagsBuf);
        gl.vertexAttribDivisor(this._aFlags.location, 1);

        if (this._aOffset) {
            this._aOffset.bindArrayBuffer(state.offsetsBuf);
            gl.vertexAttribDivisor(this._aOffset.location, 1);
        }

        geometry.indicesBuf.bind();

        gl.drawElementsInstanced(gl.TRIANGLES, geometry.indicesBuf.numItems, geometry.indicesBuf.itemType, 0, state.numInstances);

        // Cleanup

        gl.vertexAttribDivisor(this._aModelMatrixCol0.location, 0);
        gl.vertexAttribDivisor(this._aModelMatrixCol1.location, 0);
        gl.vertexAttribDivisor(this._aModelMatrixCol2.location, 0);

        gl.vertexAttribDivisor(this._aFlags.location, 0);

        if (this._aOffset) {
            gl.vertexAttribDivisor(this._aOffset.location, 0);
        }
    }

    _allocate() {

        const scene = this._scene;
        const gl = scene.canvas.gl;

        this._program = new Program(gl, this._buildShader());

        if (this._program.errors) {
            this.errors = this._program.errors;
            return;
        }

        const program = this._program;

        this._uRenderPass = program.getLocation("renderPass");
        this._uPickInvisible = program.getLocation("pickInvisible");
        this._uPositionsDecodeMatrix = program.getLocation("positionsDecodeMatrix");
        this._uWorldMatrix = program.getLocation("worldMatrix");
        this._uViewMatrix = program.getLocation("viewMatrix");
        this._uProjMatrix = program.getLocation("projMatrix");
        this._uSectionPlanes = [];

        for (let i = 0, len = scene._sectionPlanesState.sectionPlanes.length; i < len; i++) {
            this._uSectionPlanes.push({
                active: program.getLocation("sectionPlaneActive" + i),
                pos: program.getLocation("sectionPlanePos" + i),
                dir: program.getLocation("sectionPlaneDir" + i)
            });
        }

        this._aPosition = program.getAttribute("position");
        this._aOffset = program.getAttribute("offset");
        this._aFlags = program.getAttribute("flags");
        this._aModelMatrixCol0 = program.getAttribute("modelMatrixCol0");
        this._aModelMatrixCol1 = program.getAttribute("modelMatrixCol1");
        this._aModelMatrixCol2 = program.getAttribute("modelMatrixCol2");

        this._uPickZNear = program.getLocation("pickZNear");
        this._uPickZFar = program.getLocation("pickZFar");

        if (scene.logarithmicDepthBufferEnabled) {
            this._uLogDepthBufFC = program.getLocation("logDepthBufFC");
        }
    }

    _bindProgram() {
        this._program.bind();

    }

    _buildShader() {
        return {
            vertex: this._buildVertexShader(),
            fragment: this._buildFragmentShader()
        };
    }

    _buildVertexShader() {
        const scene = this._scene;
        const sectionPlanesState = scene._sectionPlanesState;
        const clipping = sectionPlanesState.sectionPlanes.length > 0;
        const src = [];
        src.push("#version 300 es");
        src.push("// Instancing geometry depth vertex shader");


        src.push("uniform int renderPass;");

        src.push("in vec3 position;");

        if (scene.entityOffsetsEnabled) {
            src.push("in vec3 offset;");
        }

        src.push("in float flags;");
        src.push("in vec4 modelMatrixCol0;"); // Modeling matrix
        src.push("in vec4 modelMatrixCol1;");
        src.push("in vec4 modelMatrixCol2;");

        src.push("uniform bool pickInvisible;");
        src.push("uniform mat4 worldMatrix;");
        src.push("uniform mat4 viewMatrix;");
        src.push("uniform mat4 projMatrix;")
        src.push("uniform mat4 positionsDecodeMatrix;");

        if (scene.logarithmicDepthBufferEnabled) {
            src.push("uniform float logDepthBufFC;");
            src.push("out float vFragDepth;");
            src.push("bool isPerspectiveMatrix(mat4 m) {");
            src.push("    return (m[2][3] == - 1.0);");
            src.push("}");
            src.push("out float isPerspective;");
        }

        if (clipping) {
            src.push("out vec4 vWorldPosition;");
            src.push("out float vFlags;");
        }

        src.push("out vec4 vViewPosition;");
        src.push("void main(void) {");

        // pickFlag = NOT_RENDERED | PICK
        // renderPass = PICK

        src.push(`int pickFlag = int(flags) >> 12 & 0xF;`);
        src.push(`if (pickFlag != renderPass) {`);
        src.push("   gl_Position = vec4(0.0, 0.0, 0.0, 0.0);"); // Cull vertex

        src.push("} else {");
        src.push("  vec4 worldPosition = positionsDecodeMatrix * vec4(position, 1.0); ");
        src.push("  worldPosition = worldMatrix * vec4(dot(worldPosition, modelMatrixCol0), dot(worldPosition, modelMatrixCol1), dot(worldPosition, modelMatrixCol2), 1.0);");

        if (scene.entityOffsetsEnabled) {
            src.push("      worldPosition.xyz = worldPosition.xyz + offset;");
        }
        src.push("  vec4 viewPosition  = viewMatrix * worldPosition; ");
        if (clipping) {
            src.push("  vWorldPosition = worldPosition;");
            src.push("  vFlags = flags;");
        }
        src.push("  vViewPosition = viewPosition;");
        src.push("vec4 clipPos = projMatrix * viewPosition;");
        if (scene.logarithmicDepthBufferEnabled) {
            src.push("vFragDepth = 1.0 + clipPos.w;");
            src.push("isPerspective = float (isPerspectiveMatrix(projMatrix));");
        }
        src.push("gl_Position = clipPos;");
        src.push("}");
        src.push("}");
        return src;
    }

    _buildFragmentShader() {
        const scene = this._scene;
        const sectionPlanesState = scene._sectionPlanesState;
        const clipping = sectionPlanesState.sectionPlanes.length > 0;
        const src = [];
        src.push("#version 300 es");
        src.push("// Batched geometry depth fragment shader");


        src.push("#ifdef GL_FRAGMENT_PRECISION_HIGH");
        src.push("precision highp float;");
        src.push("precision highp int;");
        src.push("#else");
        src.push("precision mediump float;");
        src.push("precision mediump int;");
        src.push("#endif");

        if (scene.logarithmicDepthBufferEnabled) {
            src.push("in float isPerspective;");
            src.push("uniform float logDepthBufFC;");
            src.push("in float vFragDepth;");
        }

        src.push("uniform float pickZNear;");
        src.push("uniform float pickZFar;");

        if (clipping) {
            src.push("in vec4 vWorldPosition;");
            src.push("in float vFlags;");
            for (let i = 0; i < sectionPlanesState.sectionPlanes.length; i++) {
                src.push("uniform bool sectionPlaneActive" + i + ";");
                src.push("uniform vec3 sectionPlanePos" + i + ";");
                src.push("uniform vec3 sectionPlaneDir" + i + ";");
            }
        }
        src.push("in vec4 vViewPosition;");
        src.push("vec4 packDepth(const in float depth) {");
        src.push("  const vec4 bitShift = vec4(256.0*256.0*256.0, 256.0*256.0, 256.0, 1.0);");
        src.push("  const vec4 bitMask  = vec4(0.0, 1.0/256.0, 1.0/256.0, 1.0/256.0);");
        src.push("  vec4 res = fract(depth * bitShift);");
        src.push("  res -= res.xxyz * bitMask;");
        src.push("  return res;");
        src.push("}");
        src.push("out vec4 outColor;");
        src.push("void main(void) {");
        if (clipping) {
            src.push("  bool clippable = (int(vFlags) >> 16 & 0xF) == 1;");
            src.push("  if (clippable) {");
            src.push("  float dist = 0.0;");
            for (let i = 0; i < sectionPlanesState.sectionPlanes.length; i++) {
                src.push("if (sectionPlaneActive" + i + ") {");
                src.push("   dist += clamp(dot(-sectionPlaneDir" + i + ".xyz, vWorldPosition.xyz - sectionPlanePos" + i + ".xyz), 0.0, 1000.0);");
                src.push("}");
            }
            src.push("if (dist > 0.0) { discard; }");
            src.push("}");
        }
        if (scene.logarithmicDepthBufferEnabled) {
            src.push("    gl_FragDepth = isPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;");
        }
        src.push("    float zNormalizedDepth = abs((pickZNear + vViewPosition.z) / (pickZFar - pickZNear));");
        src.push("    outColor = packDepth(zNormalizedDepth); "); // Must be linear depth
        src.push("}");
        return src;
    }

    webglContextRestored() {
        this._program = null;
    }

    destroy() {
        if (this._program) {
            this._program.destroy();
        }
        this._program = null;
    }
}

export {TrianglesInstancingPickDepthRenderer};