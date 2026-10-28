// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC-1271 wallet used only by tests: valid iff the 65-byte ECDSA
/// signature over `hash` recovers to `owner`. Not for production use.
contract TestOwnerWallet {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        address recovered = ecrecover(hash, v, r, s);
        return (recovered != address(0) && recovered == owner) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// Counterfactual factory for ERC-6492 tests.
contract TestFactory {
    function createAccount(address owner) external returns (address) {
        return address(new TestOwnerWallet{salt: bytes32(0)}(owner));
    }

    function accountAddress(address owner) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(0),
                keccak256(abi.encodePacked(type(TestOwnerWallet).creationCode, abi.encode(owner)))
            )
        );
        return address(uint160(uint256(h)));
    }
}
